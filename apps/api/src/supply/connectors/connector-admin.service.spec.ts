import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { ConnectorAdminService } from './connector-admin.service'

const T = 'tenant-a'
const U = 'user-1'
const PREFIX = 'fbeds-prod/connectors/'

interface Conn { id: string; tenantId: string; supplierId: string; type: string; status: string; name: string; version: string; transportMetadata: unknown; healthState: string; createdAt: Date; updatedAt: Date }
function world(permissions: string[], env: Record<string, string | undefined> = { CONNECTOR_SECRET_PREFIX: PREFIX }) {
  const connectors: Conn[] = []
  const creds: Array<{ id: string; connectorId: string; purpose: string; secretRef: string }> = []
  const audits: Array<{ action: string; entityId: string; payload: Record<string, unknown> }> = []
  const suppliers = [{ id: 'sup-1', tenantId: T, displayName: 'Supplier One' }]
  let seq = 0
  const join = (c: Conn) => ({ ...c, supplier: suppliers.find((s) => s.id === c.supplierId)!, credentialReferences: creds.filter((r) => r.connectorId === c.id).map((r) => ({ purpose: r.purpose })) })
  const tx = {
    userRole: { findMany: async () => [{ role: { permissions: permissions.map((key) => ({ permission: { key } })) } }] },
    auditEvent: {
      create: async ({ data }: { data: { action: string; entityId: string; payload: Record<string, unknown> } }) => { audits.push(data); return data },
      findFirst: async ({ where }: { where: { action: string; payload: { equals: string } } }) => audits.find((a) => a.action === where.action && a.payload.idempotencyKey === where.payload.equals) ?? null,
    },
    supplier: { findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => suppliers.find((s) => s.id === where.id && s.tenantId === where.tenantId) ?? null },
    supplierHotelMapping: { count: async () => 0 },
    connectorDefinition: {
      findMany: async () => connectors.filter((c) => c.tenantId === T).map(join),
      findFirst: async ({ where }: { where: { id?: string; tenantId?: string; supplierId?: string; name?: string; NOT?: { id: string } } }) => {
        const found = connectors.find((c) => (!where.id || c.id === where.id) && (!where.tenantId || c.tenantId === where.tenantId) && (!where.supplierId || c.supplierId === where.supplierId) && (!where.name || c.name === where.name) && (!where.NOT || c.id !== where.NOT.id))
        return found ? join(found) : null
      },
      findFirstOrThrow: async ({ where }: { where: { id: string } }) => join(connectors.find((c) => c.id === where.id)!),
      create: async ({ data }: { data: Omit<Conn, 'id' | 'status' | 'healthState' | 'createdAt' | 'updatedAt'> }) => { const c = { ...data, id: `conn-${++seq}`, status: 'DRAFT', healthState: 'unknown', createdAt: new Date(0), updatedAt: new Date(0) }; connectors.push(c); return c },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Conn> }) => { Object.assign(connectors.find((c) => c.id === where.id)!, data); return { id: where.id } },
    },
    connectorCredentialReference: {
      findUnique: async ({ where }: { where: { connectorId_purpose: { connectorId: string; purpose: string } } }) => creds.find((r) => r.connectorId === where.connectorId_purpose.connectorId && r.purpose === where.connectorId_purpose.purpose) ?? null,
      create: async ({ data }: { data: { connectorId: string; purpose: string; secretRef: string } }) => { creds.push({ id: `cr-${++seq}`, ...data }); return {} },
      update: async ({ where, data }: { where: { id: string }; data: { secretRef: string } }) => { creds.find((r) => r.id === where.id)!.secretRef = data.secretRef; return {} },
      deleteMany: async ({ where }: { where: { connectorId: string; purpose: string } }) => { const i = creds.findIndex((r) => r.connectorId === where.connectorId && r.purpose === where.purpose); if (i >= 0) creds.splice(i, 1); return { count: i >= 0 ? 1 : 0 } },
    },
  }
  const prisma = { withTenant: async (tenantId: string, fn: (t: typeof tx) => unknown) => { expect(tenantId).toBe(T); return fn(tx) } }
  return { service: new ConnectorAdminService(prisma as never, env), connectors, creds, audits }
}
const MANAGE = ['supply.suppliers.read', 'supply.suppliers.manage']
const create = { supplierId: 'sup-1', name: 'WebBeds XML', type: 'XML_OUT', version: '1.0', transportMetadata: { provider: 'webbeds', endpointHost: 'xml.example.com' } }

describe('ConnectorAdminService', () => {
  it('denies without the permission and audits the denial', async () => {
    const w = world(['supply.suppliers.read'])
    await expect(w.service.create(T, U, create, 'idem-key-1', 'req-1')).rejects.toBeInstanceOf(ForbiddenException)
    expect(w.audits[0]).toMatchObject({ action: 'permission.denied', entityId: 'supply.suppliers.manage' })
    expect(w.connectors).toHaveLength(0)
    const none = world([])
    await expect(none.service.list(T, U)).rejects.toBeInstanceOf(ForbiddenException)
  })
  it('creates a DRAFT connector, audits it, and reports NOT_IMPLEMENTED readiness honestly', async () => {
    const w = world(MANAGE)
    const view = await w.service.create(T, U, create, 'idem-key-1', 'req-1')
    expect(view).toMatchObject({ status: 'DRAFT', provider: 'webbeds', credentials: [] })
    expect(view.readiness).toMatchObject({ certification: 'NOT_IMPLEMENTED', searchable: false, bookable: false })
    expect(view.readiness.gates.find((g) => g.id === 'connector-active')?.passed).toBe(false)
    expect(w.audits.map((a) => a.action)).toEqual(['supply.connector.created'])
    expect(w.audits[0].payload).toMatchObject({ status: 'DRAFT', requestId: 'req-1' })
  })
  it('requires an idempotency key; replays are safe; a different body with the same key conflicts', async () => {
    const w = world(MANAGE)
    await expect(w.service.create(T, U, create, undefined)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REQUIRED' } })
    const a = await w.service.create(T, U, create, 'idem-key-1')
    const b = await w.service.create(T, U, create, 'idem-key-1')
    expect(b.id).toBe(a.id); expect(w.connectors).toHaveLength(1)
    await expect(w.service.create(T, U, { ...create, name: 'Other' }, 'idem-key-1')).rejects.toBeInstanceOf(ConflictException)
  })
  it('refuses unknown suppliers, duplicate names, status writes and a body-selected tenant', async () => {
    const w = world(MANAGE)
    await expect(w.service.create(T, U, { ...create, supplierId: 'sup-other' }, 'idem-key-1')).rejects.toBeInstanceOf(NotFoundException)
    await w.service.create(T, U, create, 'idem-key-1')
    await expect(w.service.create(T, U, create, 'idem-key-2')).rejects.toMatchObject({ response: { code: 'CONNECTOR_NAME_TAKEN' } })
    await expect(w.service.create(T, U, { ...create, name: 'X1', status: 'ACTIVE' }, 'idem-key-3')).rejects.toMatchObject({ response: { code: 'CONNECTOR_STATUS_PRIVILEGED' } })
    await expect(w.service.create(T, U, { ...create, name: 'X1', tenantId: 'other' }, 'idem-key-3')).rejects.toMatchObject({ response: { code: 'CONNECTOR_FIELD_UNKNOWN' } })
  })
  it('credential references: scoped, audited by digest only, replace and remove', async () => {
    const w = world(MANAGE)
    const { id } = await w.service.create(T, U, create, 'idem-key-1')
    const ref = `aws-sm:${PREFIX}${T}/${id}/api`
    const view = await w.service.setCredential(T, U, id, 'api', { secretRef: ref })
    expect(view.credentials).toEqual([{ purpose: 'api', status: 'configured' }])
    expect(JSON.stringify(view)).not.toContain(ref)
    const audit = w.audits.find((a) => a.action === 'supply.connector.credential_set')!
    expect(JSON.stringify(audit)).not.toContain(ref); expect(audit.payload).toMatchObject({ purpose: 'api', replaced: false })
    await w.service.setCredential(T, U, id, 'api', { secretRef: ref })
    expect(w.creds).toHaveLength(1)
    await expect(w.service.setCredential(T, U, id, 'api', { secretRef: `aws-sm:${PREFIX}tenant-b/${id}/api` })).rejects.toMatchObject({ response: { code: 'CONNECTOR_SECRET_SCOPE' } })
    await expect(w.service.setCredential(T, U, id, 'api', { secretRef: 'plaintext-password' })).rejects.toMatchObject({ response: { code: 'CONNECTOR_SECRET_REFERENCE_INVALID' } })
    expect((await w.service.removeCredential(T, U, id, 'api')).credentials).toEqual([])
    await expect(w.service.removeCredential(T, U, id, 'api')).rejects.toBeInstanceOf(NotFoundException)
  })
  it('without a configured secret prefix no credential reference can be stored', async () => {
    const w = world(MANAGE, {})
    const { id } = await w.service.create(T, U, create, 'idem-key-1')
    await expect(w.service.setCredential(T, U, id, 'api', { secretRef: `aws-sm:${PREFIX}${T}/${id}/api` })).rejects.toMatchObject({ response: { code: 'CONNECTOR_SECRETS_UNCONFIGURED' } })
  })
  it('an ACTIVE connector is locked against transport and credential edits; unknown ids 404', async () => {
    const w = world(MANAGE)
    const { id } = await w.service.create(T, U, create, 'idem-key-1')
    w.connectors[0].status = 'ACTIVE'
    await expect(w.service.update(T, U, id, { transportMetadata: { provider: 'webbeds' } })).rejects.toMatchObject({ response: { code: 'CONNECTOR_ACTIVE_LOCKED' } })
    await expect(w.service.setCredential(T, U, id, 'api', { secretRef: `aws-sm:${PREFIX}${T}/${id}/api` })).rejects.toMatchObject({ response: { code: 'CONNECTOR_ACTIVE_LOCKED' } })
    await expect(w.service.get(T, U, 'nope')).rejects.toBeInstanceOf(NotFoundException)
    await expect(w.service.get(T, U, '../etc')).rejects.toBeInstanceOf(NotFoundException)
  })
  it('readiness reflects real state: credential, secret manager and allowlist gates', async () => {
    const w = world(MANAGE, { CONNECTOR_SECRET_PREFIX: PREFIX, CONNECTOR_ALLOWED_HOSTS: 'xml.example.com' })
    const { id } = await w.service.create(T, U, create, 'idem-key-1')
    await w.service.setCredential(T, U, id, 'api', { secretRef: `aws-sm:${PREFIX}${T}/${id}/api` })
    const gates = Object.fromEntries((await w.service.get(T, U, id)).readiness.gates.map((g) => [g.id, g.passed]))
    expect(gates).toMatchObject({ 'credential-reference': true, 'secret-resolver': true, 'endpoint-allowlist': true, 'connector-active': false, 'profile-implemented': false, 'shared-gate': false, 'governed-mappings': false })
  })
})
