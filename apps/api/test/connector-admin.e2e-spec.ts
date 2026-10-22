import { randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { AgentAuditService } from '../src/agent/audit.service'
import { ApprovalService } from '../src/approvals/approval.service'
import { ConnectorAdminService } from '../src/connectors/connector-admin.service'
import { ConnectorSecretResolver, type SecretStore } from '../src/connectors/connector-secret-resolver'

jest.setTimeout(120_000)

/** Connector administration (F4, ADR 0085) and its secret resolution (F3) against PostgreSQL. The secret store is in memory: no AWS call is made. */
describe('connector administration', () => {
  const prisma = new PrismaService()
  const suffix = `conn-${Date.now()}-${randomBytes(3).toString('hex')}`
  const PREFIX = 'fbeds-test/connectors'
  const secrets = new Map<string, string>()
  const store: SecretStore = { getSecretString: async (name) => secrets.get(name) ?? null }
  const audit = new AgentAuditService(prisma)
  const make = (env: Record<string, string>) => new ConnectorAdminService(prisma, audit, new ApprovalService(prisma, audit), new ConnectorSecretResolver(env, store))
  const service = make({ CONNECTOR_SECRETS_PREFIX: PREFIX, CONNECTOR_SECRET_CACHE_MS: '0' })
  let tenantId = '', otherTenantId = '', maker = '', checker = '', supplierId = '', otherSupplierId = ''
  const SECRET_VALUE = JSON.stringify({ user: 'u', password: 'NEVER-IN-OUTPUT-123' })
  let n = 0
  const body = (patch: Record<string, unknown> = {}) => ({ supplierId, type: 'CHANNEL_MANAGER', name: `Feed ${suffix} ${++n}`, version: '1.0.0', capabilities: ['search', 'content'], ...patch })
  const ref = (connectorId: string, tenant = tenantId, leaf = 'credentials') => `aws-sm:${PREFIX}/${tenant}/${connectorId}/${leaf}`
  const putSecret = (connectorId: string, leaf = 'credentials') => secrets.set(`${PREFIX}/${tenantId}/${connectorId}/${leaf}`, SECRET_VALUE)
  const rid = () => `req-${++n}-${randomBytes(4).toString('hex')}`
  const actions = async (entityId: string) => (await prisma.auditEvent.findMany({ where: { tenantId, entityId }, orderBy: { createdAt: 'asc' } })).map((a) => a.action)

  beforeAll(async () => {
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    maker = (await prisma.user.create({ data: { email: `${suffix}-m@example.test` } })).id
    checker = (await prisma.user.create({ data: { email: `${suffix}-c@example.test` } })).id
    const sup = (t: string, name: string) => prisma.supplier.create({ data: { tenantId: t, type: 'DMC', legalName: `${suffix} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } as never }).then((s) => s.id)
    supplierId = await sup(tenantId, 'S1'); otherSupplierId = await sup(otherTenantId, 'SB')
  })

  afterAll(async () => {
    for (const t of [tenantId, otherTenantId]) {
      await prisma.approvalRequest.deleteMany({ where: { tenantId: t } })
      await prisma.auditEvent.deleteMany({ where: { tenantId: t } })
      await prisma.connectorCredentialReference.deleteMany({ where: { connector: { tenantId: t } } })
      await prisma.connectorDefinition.deleteMany({ where: { tenantId: t } })
      await prisma.supplier.deleteMany({ where: { tenantId: t } })
    }
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  it('CA-01 creates a DRAFT connector from a strict body; refuses mutating capabilities, unknown fields, foreign suppliers and duplicates', async () => {
    const c = await service.create(tenantId, maker, body())
    expect(c).toMatchObject({ status: 'DRAFT', type: 'CHANNEL_MANAGER', capabilities: ['content', 'search'], credentials: [], activation: null, supplierName: 'S1' })
    const row = await prisma.connectorDefinition.findUniqueOrThrow({ where: { id: c.id } })
    expect(row.transportMetadata).toEqual({}) // endpoints are operator configuration; this API cannot set one
    expect(await actions(c.id)).toEqual(['connector.created'])
    for (const bad of [{ capabilities: ['search', 'book'] }, { capabilities: ['cancel'] }, { capabilities: [] }, { capabilities: ['search', 'search'] }]) await expect(service.create(tenantId, maker, body(bad))).rejects.toMatchObject({ response: expect.anything() })
    await expect(service.create(tenantId, maker, body({ capabilities: ['book'] }))).rejects.toMatchObject({ response: { code: 'CONNECTOR_CAPABILITY_NOT_ENABLEABLE' } })
    await expect(service.create(tenantId, maker, { ...body(), transportMetadata: { endpoint: 'https://evil.example' } })).rejects.toThrow(/Allowed fields/)
    await expect(service.create(tenantId, maker, { ...body(), endpoint: 'https://evil.example' })).rejects.toThrow(/Allowed fields/)
    await expect(service.create(tenantId, maker, body({ type: 'SOAP' }))).rejects.toThrow(/type must be/)
    await expect(service.create(tenantId, maker, body({ name: 'x' }))).rejects.toThrow(/name must be/)
    await expect(service.create(tenantId, maker, body({ supplierId: otherSupplierId }))).rejects.toThrow(/Supplier not found/)
    await expect(service.create(tenantId, maker, body({ name: c.name }))).rejects.toMatchObject({ response: { code: 'CONNECTOR_NAME_CONFLICT' } })
  })

  it('CA-02 credential references: only under the connector\'s own prefix, never a value, never shown back, audited by hash', async () => {
    const c = await service.create(tenantId, maker, body())
    const unconfigured = make({})
    await expect(unconfigured.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id) })).rejects.toMatchObject({ response: { code: 'CONNECTOR_SECRETS_NOT_CONFIGURED' } })
    for (const secretRef of [ref(c.id, otherTenantId), ref('other-connector'), 'aws-sm:fbeds-prod/api/DATABASE_URL', `aws-sm:${PREFIX}/${tenantId}/${c.id}/../x`, 'arn:aws:secretsmanager:eu-west-1:1:secret:x', NaN as never, SECRET_VALUE]) {
      await expect(service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef })).rejects.toMatchObject({ response: { code: 'CONNECTOR_SECRET_REFERENCE_INVALID' } })
    }
    await expect(service.setCredentialReference(tenantId, maker, c.id, { purpose: 'Bad Purpose', secretRef: ref(c.id) })).rejects.toThrow(/purpose/)
    await expect(service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id), value: 'x' } as never)).rejects.toThrow(/Allowed fields/)
    const after = await service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id) })
    expect(after.credentials).toEqual([{ purpose: 'api', status: 'configured' }])
    expect(JSON.stringify(after)).not.toContain(PREFIX)
    const replaced = await service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id, tenantId, 'v2') })
    expect(replaced.credentials).toHaveLength(1)
    expect(await prisma.connectorCredentialReference.count({ where: { connectorId: c.id } })).toBe(1)
    const events = await prisma.auditEvent.findMany({ where: { tenantId, entityId: c.id, action: 'connector.credential_reference.set' } })
    expect(events).toHaveLength(2)
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(PREFIX)
    expect(events[0].payload).toMatchObject({ purpose: 'api', referenceHash: expect.stringMatching(/^[0-9a-f]{12}$/) })
  })

  it('CA-03 activation is maker-checker: a second person approves, execution needs the secret in place, and it runs once', async () => {
    const c = await service.create(tenantId, maker, body())
    await expect(service.requestActivation(tenantId, maker, c.id, { requestId: rid(), reason: 'go live' })).rejects.toThrow(/at least one credential reference/)
    await service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id) })
    const requestId = rid()
    const requested = await service.requestActivation(tenantId, maker, c.id, { requestId, reason: 'sandbox certified' })
    expect(requested.activation).toMatchObject({ status: 'PENDING', requestedById: maker, canDecide: false, canExecute: false })
    await expect(service.requestActivation(tenantId, maker, c.id, { requestId: rid(), reason: 'again' })).rejects.toThrow(/already has an open activation request/)
    expect((await service.requestActivation(tenantId, maker, c.id, { requestId, reason: 'sandbox certified' })).activation?.status).toBe('PENDING') // idempotent replay
    const approvalId = requested.activation!.approvalId
    await expect(service.decide(tenantId, maker, approvalId, 'APPROVED', { reason: 'self' })).rejects.toThrow(/cannot be decided by the user who made it/)
    expect((await service.get(tenantId, checker, c.id)).activation).toMatchObject({ canDecide: true })
    expect((await service.decide(tenantId, checker, approvalId, 'APPROVED', { reason: 'reviewed' })).activation).toMatchObject({ status: 'APPROVED', canExecute: true })
    // The secret is not in the store yet: execution refuses and the approval stays usable.
    await expect(service.execute(tenantId, maker, approvalId)).rejects.toMatchObject({ response: { code: 'CONNECTOR_SECRET_UNAVAILABLE' } })
    expect((await service.get(tenantId, maker, c.id)).status).toBe('DRAFT')
    putSecret(c.id)
    const active = await service.execute(tenantId, maker, approvalId)
    expect(active).toMatchObject({ status: 'ACTIVE', activation: null })
    await expect(service.execute(tenantId, maker, approvalId)).rejects.toThrow(/already used/)
    expect(await actions(c.id)).toEqual(expect.arrayContaining(['connector.created', 'connector.credential_reference.set', 'connector.activated']))
    expect(JSON.stringify(await prisma.auditEvent.findMany({ where: { tenantId } }))).not.toContain('NEVER-IN-OUTPUT')
  })

  it('CA-04 a connector changed after approval cannot be activated with that approval', async () => {
    const c = await service.create(tenantId, maker, body())
    putSecret(c.id); putSecret(c.id, 'second')
    await service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id) })
    const approvalId = (await service.requestActivation(tenantId, maker, c.id, { requestId: rid(), reason: 'review me' })).activation!.approvalId
    await service.decide(tenantId, checker, approvalId, 'APPROVED', { reason: 'looks right' })
    await service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id, tenantId, 'second') }) // swapped after approval
    await expect(service.execute(tenantId, maker, approvalId)).rejects.toMatchObject({ response: { code: 'CONNECTOR_CHANGED_SINCE_APPROVAL' } })
    expect((await service.get(tenantId, maker, c.id)).status).toBe('DRAFT')
  })

  it('CA-05 an active connector\'s credentials are locked; suspending is direct; reactivation needs a new approval; disabling is final', async () => {
    const c = await service.create(tenantId, maker, body())
    putSecret(c.id)
    await service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id) })
    const approvalId = (await service.requestActivation(tenantId, maker, c.id, { requestId: rid(), reason: 'go live now' })).activation!.approvalId
    await service.decide(tenantId, checker, approvalId, 'APPROVED', { reason: 'looks right' })
    await service.execute(tenantId, maker, approvalId)
    await expect(service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id, tenantId, 'v2') })).rejects.toMatchObject({ response: { code: 'CONNECTOR_NOT_EDITABLE' } })
    await expect(service.suspend(tenantId, maker, c.id, { reason: 'x' })).rejects.toThrow(/reason of 3 to 500/)
    expect((await service.suspend(tenantId, maker, c.id, { reason: 'rotating credentials' })).status).toBe('SUSPENDED')
    expect((await service.suspend(tenantId, maker, c.id, { reason: 'rotating credentials' })).status).toBe('SUSPENDED') // idempotent
    putSecret(c.id, 'v2')
    await service.setCredentialReference(tenantId, maker, c.id, { purpose: 'api', secretRef: ref(c.id, tenantId, 'v2') })
    const again = (await service.requestActivation(tenantId, maker, c.id, { requestId: rid(), reason: 'rotated' })).activation!.approvalId
    await service.decide(tenantId, checker, again, 'APPROVED', { reason: 'looks right' })
    expect((await service.execute(tenantId, maker, again)).status).toBe('ACTIVE')
    expect((await service.disable(tenantId, maker, c.id, { reason: 'supplier contract ended' })).status).toBe('DISABLED')
    await expect(service.suspend(tenantId, maker, c.id, { reason: 'too late' })).rejects.toMatchObject({ response: { code: 'CONNECTOR_NOT_EDITABLE' } })
    await expect(service.requestActivation(tenantId, maker, c.id, { requestId: rid(), reason: 'revive' })).rejects.toMatchObject({ response: { code: 'CONNECTOR_NOT_EDITABLE' } })
    expect(await actions(c.id)).toEqual(expect.arrayContaining(['connector.suspended', 'connector.disabled']))
  })

  it('CA-06 another tenant sees and changes nothing, and a non-activation approval cannot be used here', async () => {
    const c = await service.create(tenantId, maker, body())
    await expect(service.get(otherTenantId, maker, c.id)).rejects.toThrow(/Connector not found/)
    expect((await service.list(otherTenantId, maker)).map((x) => x.id)).not.toContain(c.id)
    expect((await service.list(tenantId, maker, { supplierId })).map((x) => x.id)).toContain(c.id)
    await expect(service.suspend(otherTenantId, maker, c.id, { reason: 'nope nope' })).rejects.toThrow(/Connector not found/)
    await expect(service.list(tenantId, maker, { supplierId: '../x' })).rejects.toThrow(/Invalid supplierId/)
    const stray = await new ApprovalService(prisma, audit).request({ tenantId, requesterId: maker, action: 'markup.activate', entityType: 'commercial_markup_rule', entityId: 'rule-1', requestId: rid(), reason: 'unrelated' })
    await expect(service.execute(tenantId, checker, stray.id)).rejects.toThrow(/Not a connector activation approval/)
    await expect(service.decide(tenantId, checker, stray.id, 'APPROVED', { reason: 'no' })).rejects.toThrow(/Not a connector activation approval/)
  })
})
