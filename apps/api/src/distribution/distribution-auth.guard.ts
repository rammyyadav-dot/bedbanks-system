import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, ServiceUnavailableException, SetMetadata, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request, Response } from 'express'
import { PrismaService } from '../database/prisma.service'
import { ipAllowed, isAccessToken, parseApiKey, sha256Hex, type DistributionDbScope } from './distribution-credentials'

/**
 * Authenticates a machine partner of the B2B Distribution API (ADR 0075, amendment 4) and enforces the scope the handler declares.
 *
 *   Authorization: ApiKey fbk_<keyId>_<secret>     an API_KEY credential
 *   Authorization: Bearer fbt_<token>              an OAuth access token
 *
 * Identity comes only from the credential, through `fbeds_distribution_authenticate_key` / `_token` (SECURITY DEFINER): the runtime reads no
 * credential table and never sees a hash. A session cookie is not a partner credential and is ignored. Every refusal of the credential is
 * the same 401, whatever the reason (the reason is logged, the credential never is). A database failure is 503, never 401 or a pass.
 *
 * Fail closed: a handler behind this guard must declare `@RequireDistributionScope(...)`; `SELF` marks a route that answers only about the
 * caller (like GET /auth/me) and needs no scope.
 */
export const DISTRIBUTION_SCOPE = 'fbeds:distribution-scope'
export type DistributionRequirement = DistributionDbScope | 'SELF'
export const RequireDistributionScope = (requirement: DistributionRequirement) => SetMetadata(DISTRIBUTION_SCOPE, requirement)

export const DISTRIBUTION_PRINCIPAL_KEY = 'distributionPrincipal'
export interface DistributionPrincipal {
  tenantId: string
  agencyId: string
  clientId: string
  authenticatedWith: 'api_key' | 'access_token'
  /** The credential (API key) or token id; never the secret or a hash. */
  credentialRef: string
  scopes: DistributionDbScope[]
  limits: { searchPerMinute: number; checkRatePerMinute: number; bookPerMinute: number }
}

export function distributionPrincipal(request: Request): DistributionPrincipal {
  const principal = (request as unknown as Record<string, unknown>)[DISTRIBUTION_PRINCIPAL_KEY] as DistributionPrincipal | undefined
  if (!principal) throw new UnauthorizedException('Not authenticated')
  return principal
}

const REALM = 'Bearer realm="fbeds-distribution"'
type AuthRow = { tenant_id: string; agency_id: string; client_id: string; ref: string; kind: string | null; scopes: string[]; ip_allowlist: string[]; search_per_minute: number; check_rate_per_minute: number; book_per_minute: number }

@Injectable()
export class DistributionAuthGuard implements CanActivate {
  private readonly logger = new Logger(DistributionAuthGuard.name)

  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const response = context.switchToHttp().getResponse<Response>()
    const refuse = (reason: string): never => {
      this.logger.warn(JSON.stringify({ event: 'distribution_auth_refused', reason, requestId: request.requestId ?? null }))
      response.setHeader('WWW-Authenticate', reason === 'missing_credential' ? REALM : `${REALM}, error="invalid_token"`)
      throw new UnauthorizedException('Partner credential is missing, invalid or not active')
    }

    const header = request.header('authorization') ?? ''
    const space = header.indexOf(' ')
    const scheme = space > 0 ? header.slice(0, space).toLowerCase() : ''
    const value = space > 0 ? header.slice(space + 1).trim() : ''
    if (!scheme || !value) return refuse('missing_credential')

    let row: AuthRow | undefined
    let authenticatedWith: DistributionPrincipal['authenticatedWith']
    try {
      if (scheme === 'apikey') {
        const key = parseApiKey(value)
        if (!key) return refuse('malformed_credential')
        authenticatedWith = 'api_key'
        ;[row] = await this.prisma.$queryRaw<AuthRow[]>`
          SELECT "tenant_id", "agency_id", "client_id", "credential_id" AS "ref", "kind"::text AS "kind", "scopes"::text[] AS "scopes",
                 "ip_allowlist", "search_per_minute", "check_rate_per_minute", "book_per_minute"
            FROM "fbeds_distribution_authenticate_key"(${key.keyId}, ${sha256Hex(key.secret)})`
        // An OAuth client secret is exchanged for short-lived tokens; it is never itself a bearer of API calls.
        if (row && row.kind !== 'API_KEY') return refuse('oauth_secret_used_as_api_key')
      } else if (scheme === 'bearer') {
        if (!isAccessToken(value)) return refuse('malformed_credential')
        authenticatedWith = 'access_token'
        ;[row] = await this.prisma.$queryRaw<AuthRow[]>`
          SELECT "tenant_id", "agency_id", "client_id", "token_id" AS "ref", NULL::text AS "kind", "scopes"::text[] AS "scopes",
                 "ip_allowlist", "search_per_minute", "check_rate_per_minute", "book_per_minute"
            FROM "fbeds_distribution_authenticate_token"(${sha256Hex(value)})`
      } else {
        return refuse('unsupported_scheme')
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error
      this.logger.error(JSON.stringify({ event: 'distribution_auth_unavailable', requestId: request.requestId ?? null, errorName: error instanceof Error ? error.name : 'UnknownError' }))
      throw new ServiceUnavailableException('Partner authentication is temporarily unavailable')
    }
    if (!row) return refuse('unknown_or_inactive_credential')

    // The allowlist is checked against the connection address Express reports. Behind a proxy that is not trusted (`trust proxy`), that is the
    // proxy, so an allowlisted client is refused rather than let through: this check can only fail closed.
    if (!ipAllowed(request.ip, row.ip_allowlist)) return refuse('ip_not_allowed')

    const principal: DistributionPrincipal = {
      tenantId: row.tenant_id, agencyId: row.agency_id, clientId: row.client_id, authenticatedWith, credentialRef: row.ref,
      scopes: row.scopes as DistributionDbScope[],
      limits: { searchPerMinute: row.search_per_minute, checkRatePerMinute: row.check_rate_per_minute, bookPerMinute: row.book_per_minute },
    }
    ;(request as unknown as Record<string, unknown>)[DISTRIBUTION_PRINCIPAL_KEY] = principal

    const required = this.reflector.getAllAndOverride<DistributionRequirement | undefined>(DISTRIBUTION_SCOPE, [context.getHandler(), context.getClass()])
    if (!required) throw new ForbiddenException('Access denied')
    if (required !== 'SELF' && !principal.scopes.includes(required)) {
      response.setHeader('WWW-Authenticate', `${REALM}, error="insufficient_scope"`)
      throw new ForbiddenException('The credential does not carry the required scope')
    }
    return true
  }
}
