import { Injectable, Logger } from '@nestjs/common'
import { DISTRIBUTION_TOKEN_TTL_SECONDS, type DistributionTokenError, type DistributionTokenResponse } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { newAccessToken, parseClientCredentials, parseScopeParam, sha256Hex, toWireScopes } from './distribution-credentials'

export interface TokenRequestInput {
  /** The raw Authorization header, if any. */
  authorization: string | undefined
  body: Record<string, unknown> | undefined
  requestId: string | undefined
}
export type TokenOutcome =
  | { status: 200; body: DistributionTokenResponse }
  | { status: 400 | 401 | 503; body: DistributionTokenError; basicChallenge?: boolean }

type IssueRow = { outcome: 'issued' | 'invalid_scope'; token_id: string | null; scopes: string[] | null; client_id: string }

/**
 * OAuth 2.0 client credentials (RFC 6749 section 4.4) for the B2B Distribution API (ADR 0075, amendment 4).
 *
 * The client authenticates with HTTP Basic or body `client_id`/`client_secret` (never both, RFC 6749 section 2.3). The secret is hashed here
 * and checked, together with the token write and its audit event, inside `fbeds_distribution_issue_token` (SECURITY DEFINER): the runtime
 * holds no privilege on the token table, and cannot mint a token without a valid client secret. Only the token's SHA-256 is stored; the token
 * itself is returned once and never logged.
 */
@Injectable()
export class DistributionTokenService {
  private readonly logger = new Logger(DistributionTokenService.name)

  constructor(private readonly prisma: PrismaService) {}

  async issue(input: TokenRequestInput): Promise<TokenOutcome> {
    const body = input.body && typeof input.body === 'object' ? input.body : {}
    const invalid = (error: DistributionTokenError['error'], description: string, status: 400 | 401 = 400, basicChallenge = false): TokenOutcome =>
      ({ status, body: { error, error_description: description }, basicChallenge })

    // Client authentication comes first, so an unauthenticated caller learns nothing about the rest of the request.
    const basic = /^basic\s+/i.test(input.authorization ?? '')
    const inBody = body.client_id !== undefined || body.client_secret !== undefined
    if (basic && inBody) return invalid('invalid_request', 'Use one client authentication method, not both')
    let credentials: ReturnType<typeof parseClientCredentials>
    if (basic) {
      const decoded = decodeBasic(input.authorization!)
      credentials = decoded ? parseClientCredentials(decoded.id, decoded.secret) : null
    } else if (inBody) {
      credentials = parseClientCredentials(body.client_id, body.client_secret)
    } else {
      return invalid('invalid_client', 'Client authentication is required', 401, true)
    }
    if (!credentials) return this.refused('malformed_client_credentials', input.requestId, basic)
    if (body.grant_type !== 'client_credentials') {
      return body.grant_type === undefined ? invalid('invalid_request', 'grant_type is required') : invalid('unsupported_grant_type', 'Only client_credentials is supported')
    }

    const requested = parseScopeParam(body.scope)
    if (!requested.ok) return invalid('invalid_scope', 'scope must be space-separated names from: search checkrate book cancel bookings:read')

    // Generated before the call so only its hash crosses into the database; handed out only after the write committed.
    const token = newAccessToken()
    let row: IssueRow | undefined
    try {
      ;[row] = await this.prisma.$queryRaw<IssueRow[]>`
        SELECT "outcome", "token_id", "scopes"::text[] AS "scopes", "client_id"
          FROM "fbeds_distribution_issue_token"(${credentials.keyId}, ${sha256Hex(credentials.secret)}, ${sha256Hex(token)},
                                                ${requested.scopes}::"DistributionApiScope"[], ${DISTRIBUTION_TOKEN_TTL_SECONDS}::int, ${input.requestId ?? null})`
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'distribution_token_unavailable', requestId: input.requestId ?? null, errorName: error instanceof Error ? error.name : 'UnknownError' }))
      return { status: 503, body: { error: 'temporarily_unavailable', error_description: 'Token issuance is temporarily unavailable' } }
    }
    if (!row) return this.refused('unknown_or_inactive_client', input.requestId, basic)
    if (row.outcome === 'invalid_scope') return invalid('invalid_scope', 'A requested scope is not granted to this client')

    this.logger.log(JSON.stringify({ event: 'distribution_token_issued', clientId: row.client_id, tokenId: row.token_id, requestId: input.requestId ?? null }))
    return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: DISTRIBUTION_TOKEN_TTL_SECONDS, scope: toWireScopes(row.scopes ?? []).join(' ') } }
  }

  private refused(reason: string, requestId: string | undefined, basic: boolean): TokenOutcome {
    this.logger.warn(JSON.stringify({ event: 'distribution_token_refused', reason, requestId: requestId ?? null }))
    return { status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed' }, basicChallenge: basic }
  }
}

/** RFC 7617 Basic credentials; client_id and secret are form-urlencoded inside it (RFC 6749 section 2.3.1). */
function decodeBasic(header: string): { id: string; secret: string } | null {
  const encoded = header.replace(/^basic\s+/i, '').trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 512) return null
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon <= 0) return null
  try {
    return { id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')) }
  } catch { return null }
}
