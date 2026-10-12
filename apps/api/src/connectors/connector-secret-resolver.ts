import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'

/**
 * Resolves a `ConnectorCredentialReference.secretRef` to secret material at call time (ADR 0061). The material is returned to the
 * transport's request builder only: it is never stored, logged, cached beyond a short in-memory window, or placed in an error.
 *
 * Reference format: `aws-sm:<prefix><tenantId>/<connectorId>/<purpose>` where `<prefix>` is the deployment's
 * `CONNECTOR_SECRET_PREFIX` (for example `fbeds-prod/connectors/`). Three controls make a reference unusable outside its owner:
 *  - it must start with the configured prefix, so a connector can never point at a database or platform secret;
 *  - the tenant and connector segments must equal the server-derived scope, so tenant A's connector cannot read tenant B's secret
 *    even if a row were edited (CLAUDE.md invariant 1);
 *  - the secret value must be a flat JSON object of non-empty strings, otherwise it is refused.
 */
export type ConnectorSecretErrorCode = 'unconfigured' | 'invalid_reference' | 'scope_mismatch' | 'unavailable' | 'invalid_secret'
export class ConnectorSecretError extends Error {
  constructor(readonly code: ConnectorSecretErrorCode) { super(`Connector secret unavailable (${code})`); this.name = 'ConnectorSecretError' }
}
export interface ConnectorSecretScope { tenantId: string; supplierId: string; connectorId: string }
export type ConnectorSecretMaterial = Readonly<Record<string, string>>
export interface ConnectorSecretResolver { resolve(reference: string, scope: ConnectorSecretScope): Promise<ConnectorSecretMaterial> }
export const CONNECTOR_SECRET_RESOLVER = Symbol('CONNECTOR_SECRET_RESOLVER')

const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/
const PREFIX = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/$/
const REFERENCE = /^aws-sm:([A-Za-z0-9_\/-]{1,200})$/

/** The honest default: no secret manager is bound, so nothing resolves. */
export class UnconfiguredConnectorSecretResolver implements ConnectorSecretResolver {
  async resolve(): Promise<ConnectorSecretMaterial> { throw new ConnectorSecretError('unconfigured') }
}

export interface AwsConnectorSecretOptions { prefix: string; ttlMs?: number; now?: () => number }
type SendClient = Pick<SecretsManagerClient, 'send'>

export class AwsConnectorSecretResolver implements ConnectorSecretResolver {
  private readonly cache = new Map<string, { value: ConnectorSecretMaterial; expires: number }>()
  constructor(private readonly client: SendClient, private readonly options: AwsConnectorSecretOptions, private readonly getCommand: (id: string) => Parameters<SendClient['send']>[0]) {
    if (!PREFIX.test(options.prefix)) throw new ConnectorSecretError('invalid_reference')
  }

  /** Validates the reference against the prefix and scope WITHOUT contacting AWS. Returns the secret id. */
  secretId(reference: string, scope: ConnectorSecretScope): string {
    const match = REFERENCE.exec(reference)
    if (!match || !SEGMENT.test(scope.tenantId) || !SEGMENT.test(scope.connectorId)) throw new ConnectorSecretError('invalid_reference')
    const id = match[1]
    const rest = id.startsWith(this.options.prefix) ? id.slice(this.options.prefix.length) : null
    if (rest === null) throw new ConnectorSecretError('invalid_reference')
    const [tenant, connector, purpose, ...extra] = rest.split('/')
    if (!tenant || !connector || !purpose || extra.length || !SEGMENT.test(purpose)) throw new ConnectorSecretError('invalid_reference')
    if (tenant !== scope.tenantId || connector !== scope.connectorId) throw new ConnectorSecretError('scope_mismatch')
    return id
  }

  async resolve(reference: string, scope: ConnectorSecretScope): Promise<ConnectorSecretMaterial> {
    const id = this.secretId(reference, scope)
    const now = (this.options.now ?? Date.now)()
    const hit = this.cache.get(id)
    if (hit && hit.expires > now) return hit.value
    let text: string | undefined
    try { text = (await this.client.send(this.getCommand(id)) as { SecretString?: string }).SecretString } catch { throw new ConnectorSecretError('unavailable') }
    const value = parseMaterial(text)
    this.cache.set(id, { value, expires: now + (this.options.ttlMs ?? 60_000) })
    return value
  }
}

function parseMaterial(text: string | undefined): ConnectorSecretMaterial {
  let parsed: unknown
  try { parsed = JSON.parse(text ?? '') } catch { throw new ConnectorSecretError('invalid_secret') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConnectorSecretError('invalid_secret')
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0 || entries.length > 20 || entries.some(([k, v]) => !/^[A-Za-z0-9_]{1,64}$/.test(k) || typeof v !== 'string' || v.length === 0 || v.length > 4096)) throw new ConnectorSecretError('invalid_secret')
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>)
}

/** Composition: AWS when `CONNECTOR_SECRET_PREFIX` is set, otherwise the unconfigured resolver. Never a fallback to env or defaults. */
export async function connectorSecretResolverFromEnvironment(env: Record<string, string | undefined> = process.env): Promise<ConnectorSecretResolver> {
  const prefix = env.CONNECTOR_SECRET_PREFIX?.trim()
  if (!prefix) return new UnconfiguredConnectorSecretResolver()
  const sdk = await import('@aws-sdk/client-secrets-manager')
  return new AwsConnectorSecretResolver(new sdk.SecretsManagerClient({ region: env.AWS_REGION }), { prefix }, (id) => new sdk.GetSecretValueCommand({ SecretId: id }) as never)
}
