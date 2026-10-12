import { BadRequestException } from '@nestjs/common'
import { ConnectorSecretError, validateConnectorSecretReference } from '../../connectors/connector-secret-resolver'

/**
 * Input rules for the connector admin API (ADR 0062). Pure and exhaustive: unknown fields are refused rather than ignored, and nothing
 * that looks like secret material can be stored in a connector row (CLAUDE.md invariant 7).
 *
 * `status` and `capabilities` are never accepted. A connector is created DRAFT; activation is a privileged operator action that is
 * only possible once a provider profile reaches SANDBOX_CERTIFIED (see evaluateReadiness), so the API cannot make a supplier "live".
 */
export const CONNECTOR_TYPES = ['API_JSON', 'XML_IN', 'XML_OUT', 'CHANNEL_MANAGER', 'MANUAL_EXTRANET'] as const
export type ConnectorTypeInput = (typeof CONNECTOR_TYPES)[number]
const TRANSPORT_KEYS = ['provider', 'endpointHost', 'wireFormat', 'specVersion'] as const
const SECRET_LIKE = /secret|passw|token|credential|apikey|api_key|authorization|bearer|private/i
const bad = (code: string, message: string): never => { throw new BadRequestException({ code, message }) }
const text = (value: unknown, field: string, pattern: RegExp, hint: string): string => {
  if (typeof value !== 'string' || !pattern.test(value.trim())) bad('CONNECTOR_FIELD_INVALID', `${field} ${hint}`)
  return (value as string).trim()
}
function only(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('CONNECTOR_BODY_INVALID', 'A JSON object is required.')
  const body = input as Record<string, unknown>
  if ('status' in body || 'capabilities' in body || 'healthState' in body) bad('CONNECTOR_STATUS_PRIVILEGED', 'Status, capabilities and health are not writable here: activation is a privileged, certified step.')
  const extra = Object.keys(body).filter((k) => !allowed.includes(k))
  if (extra.length) bad('CONNECTOR_FIELD_UNKNOWN', `Unknown field(s): ${extra.join(', ')}.`)
  return body
}

export interface ConnectorCreate { supplierId: string; name: string; type: ConnectorTypeInput; version: string; transportMetadata: Record<string, string> }
export interface ConnectorUpdate { name?: string; version?: string; transportMetadata?: Record<string, string> }

export function parseTransportMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('CONNECTOR_TRANSPORT_INVALID', 'transportMetadata must be an object.')
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_LIKE.test(key)) bad('CONNECTOR_SECRET_IN_METADATA', 'Secret material must never be stored in a connector. Use a credential reference.')
    if (!(TRANSPORT_KEYS as readonly string[]).includes(key)) bad('CONNECTOR_TRANSPORT_INVALID', `Unknown transportMetadata field: ${key}.`)
    if (typeof raw !== 'string') bad('CONNECTOR_TRANSPORT_INVALID', `${key} must be a string.`)
    out[key] = raw as string
  }
  if (out.provider !== undefined) text(out.provider, 'provider', /^[a-z][a-z0-9-]{1,31}$/, 'must be a lowercase provider key')
  // A host name only: never a URL, so no path, query, credentials or scheme can be stored. The deployment allowlist decides what may be called.
  if (out.endpointHost !== undefined) text(out.endpointHost, 'endpointHost', /^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/, 'must be a lowercase host name without scheme or path')
  if (out.wireFormat !== undefined) text(out.wireFormat, 'wireFormat', /^(xml|soap)$/, 'must be xml or soap')
  if (out.specVersion !== undefined) text(out.specVersion, 'specVersion', /^[A-Za-z0-9._-]{1,32}$/, 'is invalid')
  return out
}

export function parseConnectorCreate(input: unknown): ConnectorCreate {
  const body = only(input, ['supplierId', 'name', 'type', 'version', 'transportMetadata'])
  const type = body.type
  if (typeof type !== 'string' || !(CONNECTOR_TYPES as readonly string[]).includes(type)) bad('CONNECTOR_FIELD_INVALID', `type must be one of ${CONNECTOR_TYPES.join(', ')}.`)
  return {
    supplierId: text(body.supplierId, 'supplierId', /^[A-Za-z0-9_-]{1,100}$/, 'is invalid'),
    name: text(body.name, 'name', /^[A-Za-z0-9][A-Za-z0-9 ._()-]{1,79}$/, 'must be 2-80 characters'),
    type: type as ConnectorTypeInput,
    version: text(body.version, 'version', /^[A-Za-z0-9._-]{1,32}$/, 'is invalid'),
    transportMetadata: body.transportMetadata === undefined ? {} : parseTransportMetadata(body.transportMetadata),
  }
}

export function parseConnectorUpdate(input: unknown): ConnectorUpdate {
  const body = only(input, ['name', 'version', 'transportMetadata'])
  const out: ConnectorUpdate = {}
  if (body.name !== undefined) out.name = text(body.name, 'name', /^[A-Za-z0-9][A-Za-z0-9 ._()-]{1,79}$/, 'must be 2-80 characters')
  if (body.version !== undefined) out.version = text(body.version, 'version', /^[A-Za-z0-9._-]{1,32}$/, 'is invalid')
  if (body.transportMetadata !== undefined) out.transportMetadata = parseTransportMetadata(body.transportMetadata)
  if (Object.keys(out).length === 0) bad('CONNECTOR_BODY_INVALID', 'Nothing to change.')
  return out
}

export function parseCredentialPurpose(value: unknown): string { return text(value, 'purpose', /^[a-z][a-z0-9_-]{1,31}$/, 'must be a lowercase word such as api') }

/** The reference must be this connector's own secret under the deployment prefix. Without a prefix nothing can be stored. */
export function parseCredentialReference(input: unknown, prefix: string | undefined, scope: { tenantId: string; connectorId: string }, purpose: string): string {
  const body = only(input, ['secretRef'])
  if (!prefix) return bad('CONNECTOR_SECRETS_UNCONFIGURED', 'No secret manager is configured for connector credentials in this deployment.')
  const ref = typeof body.secretRef === 'string' ? body.secretRef.trim() : ''
  try { validateConnectorSecretReference(prefix, ref, scope) } catch (error) {
    if (error instanceof ConnectorSecretError && error.code === 'scope_mismatch') return bad('CONNECTOR_SECRET_SCOPE', 'The reference must name this tenant and connector.')
    return bad('CONNECTOR_SECRET_REFERENCE_INVALID', 'The reference must be aws-sm:<prefix><tenantId>/<connectorId>/<purpose>.')
  }
  if (!ref.endsWith(`/${purpose}`)) bad('CONNECTOR_SECRET_PURPOSE', 'The reference must end with the credential purpose.')
  return ref
}
