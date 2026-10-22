import { Injectable, Logger, Optional } from '@nestjs/common'
import { GetSecretValueCommand, ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

/**
 * Resolution of connector credential references to secret material (audit finding F3, CLAUDE.md invariant 7).
 *
 * A stored reference is `aws-sm:<secret name>`. It names a location, never a value. Three rules keep a tenant-supplied reference from reaching anything it should not:
 *  1. The deployment configures a prefix (`CONNECTOR_SECRETS_PREFIX`, for example `fbeds-prod/connectors`). Unset means unconfigured: nothing resolves.
 *  2. A reference must lie under `<prefix>/<tenantId>/<connectorId>/` of the connector asking for it. Another tenant's secret, another connector's secret, and platform secrets
 *     such as `<env>/api/DATABASE_URL` are all out of scope and refused before any call is made. (Grant the task role `secretsmanager:GetSecretValue` on that prefix only.)
 *  3. Only secret names are accepted, never ARNs, so a reference cannot select another account or region.
 * The value must be a JSON object of short string values. Failures are classified by a code only: no message, log line or error carries a reference or a value.
 * Successful reads are cached in memory for a short time and failures are never cached.
 */
export type SecretFailure = 'not_configured' | 'invalid_reference' | 'out_of_scope' | 'not_found' | 'malformed' | 'unavailable'
export class SecretResolutionError extends Error {
  constructor(readonly code: SecretFailure) { super(`Secret resolution failed (${code})`); this.name = 'SecretResolutionError' }
}

export interface SecretStore { getSecretString(name: string): Promise<string | null> }
export interface SecretScope { tenantId: string; connectorId: string }

const SCHEME = 'aws-sm:'
const NAME = /^[A-Za-z0-9/_+=.@-]{1,200}$/
const PREFIX = /^[a-z0-9][a-z0-9/_-]{2,60}[a-z0-9]$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const MAX_KEYS = 20
const MAX_BYTES = 8_192
const MAX_VALUE_CHARS = 2_048
const MAX_CACHE_ENTRIES = 100
const DEFAULT_CACHE_MS = 60_000
const MAX_CACHE_MS = 300_000

export class AwsSecretsManagerStore implements SecretStore {
  constructor(private readonly client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({})) {}
  async getSecretString(name: string): Promise<string | null> {
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: name }))
      return typeof out.SecretString === 'string' ? out.SecretString : null
    } catch (error) {
      if (error instanceof ResourceNotFoundException || (error as { name?: string }).name === 'ResourceNotFoundException') return null
      throw error
    }
  }
}

/** Parses and scopes a reference without any I/O. Returns the secret name. Exported so the admin API applies the identical rule when a reference is stored. */
export function scopedSecretName(reference: string, scope: SecretScope, prefix: string | undefined): string {
  if (!prefix || !PREFIX.test(prefix) || prefix.includes('//')) throw new SecretResolutionError('not_configured')
  if (typeof reference !== 'string' || !reference.startsWith(SCHEME) || reference.length > SCHEME.length + 200) throw new SecretResolutionError('invalid_reference')
  const name = reference.slice(SCHEME.length)
  if (!NAME.test(name) || name.includes('..') || name.includes('//') || name.endsWith('/')) throw new SecretResolutionError('invalid_reference')
  if (!ID.test(scope.tenantId) || !ID.test(scope.connectorId)) throw new SecretResolutionError('invalid_reference')
  const base = `${prefix}/${scope.tenantId}/${scope.connectorId}/`
  if (!name.startsWith(base) || name.length === base.length) throw new SecretResolutionError('out_of_scope')
  return name
}

@Injectable()
export class ConnectorSecretResolver {
  private readonly logger = new Logger(ConnectorSecretResolver.name)
  private readonly cache = new Map<string, { value: Readonly<Record<string, string>>; expires: number }>()
  private readonly prefix: string | undefined
  private readonly cacheMs: number
  private readonly store: SecretStore

  constructor(@Optional() env?: Record<string, string | undefined>, @Optional() store?: SecretStore, @Optional() private readonly clock: () => number = Date.now) {
    const e = env ?? process.env
    this.prefix = e.CONNECTOR_SECRETS_PREFIX?.trim() || undefined
    const requested = e.CONNECTOR_SECRET_CACHE_MS === undefined ? DEFAULT_CACHE_MS : Number(e.CONNECTOR_SECRET_CACHE_MS)
    if (!Number.isInteger(requested) || requested < 0 || requested > MAX_CACHE_MS) throw new Error(`CONNECTOR_SECRET_CACHE_MS must be an integer from 0 to ${MAX_CACHE_MS}`)
    if (this.prefix !== undefined && (!PREFIX.test(this.prefix) || this.prefix.includes('//'))) throw new Error('CONNECTOR_SECRETS_PREFIX must be a lowercase path such as fbeds-prod/connectors, without a trailing slash')
    this.cacheMs = requested
    // The AWS client is created lazily so an unconfigured deployment never builds one.
    this.store = store ?? { getSecretString: (name) => (this.aws ??= new AwsSecretsManagerStore()).getSecretString(name) }
  }
  private aws?: AwsSecretsManagerStore

  configured(): boolean { return this.prefix !== undefined }
  /** The configured prefix, for the admin API's structural check. Not a secret. */
  secretPrefix(): string | undefined { return this.prefix }

  /** The secret material as a frozen object of strings. Throws `SecretResolutionError` with a code only. */
  async resolve(reference: string, scope: SecretScope): Promise<Readonly<Record<string, string>>> {
    const name = scopedSecretName(reference, scope, this.prefix)
    const now = this.clock()
    const hit = this.cache.get(name)
    if (hit && hit.expires > now) return hit.value
    if (hit) this.cache.delete(name)
    let raw: string | null
    try { raw = await this.store.getSecretString(name) } catch {
      // Class only: the error can name the secret and the account.
      this.logger.error('Connector secret store call failed')
      throw new SecretResolutionError('unavailable')
    }
    if (raw === null) throw new SecretResolutionError('not_found')
    const value = parseSecretObject(raw)
    if (this.cacheMs > 0) {
      if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string)
      this.cache.set(name, { value, expires: now + this.cacheMs })
    }
    return value
  }

  /** Whether a reference resolves to a well-formed secret, without returning it. Used to refuse activating a connector whose secret is not in place. */
  async check(reference: string, scope: SecretScope): Promise<{ ok: true } | { ok: false; reason: SecretFailure }> {
    try { await this.resolve(reference, scope); return { ok: true } } catch (error) {
      return { ok: false, reason: error instanceof SecretResolutionError ? error.code : 'unavailable' }
    }
  }

  /** The port the XML transport takes: `resolveSecret(reference, scope)`, with the provider profile validating the shape of its own secret. */
  asTransportResolver<S>(validate: (raw: Readonly<Record<string, string>>) => S): (reference: string, scope: { tenantId: string; supplierId: string; connectorId: string }) => Promise<S> {
    return async (reference, scope) => validate(await this.resolve(reference, { tenantId: scope.tenantId, connectorId: scope.connectorId }))
  }

  clearCache(): void { this.cache.clear() }
}

function parseSecretObject(raw: string): Readonly<Record<string, string>> {
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new SecretResolutionError('malformed')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new SecretResolutionError('malformed') }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SecretResolutionError('malformed')
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_KEYS) throw new SecretResolutionError('malformed')
  const out: Record<string, string> = Object.create(null)
  for (const [k, v] of entries) {
    if (!KEY.test(k) || typeof v !== 'string' || v.length === 0 || v.length > MAX_VALUE_CHARS) throw new SecretResolutionError('malformed')
    out[k] = v
  }
  return Object.freeze(out)
}
