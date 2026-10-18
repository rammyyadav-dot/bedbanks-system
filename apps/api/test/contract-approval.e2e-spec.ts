import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

/**
 * ADR 0067 (F-01): a contract goes live only through an approved, single-use request decided by a second person and bound to the exact terms
 * reviewed; an ACTIVE contract changes only by an approved amendment; every applied change appends an immutable version snapshot.
 * Everything runs through the real HTTP API against a disposable PostgreSQL; the owner Prisma client only arranges and observes.
 */
const prisma = new PrismaClient()
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY).toISOString().slice(0, 10)

describe('Contract maker-checker and versioning (ADR 0067)', () => {
  const suffix = `contract-approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'contract-approval-certification-password'
  let app: INestApplication
  let tenantId: string, otherTenantId: string
  let maker: string, checker: string, readOnly: string, outsider: string
  const userIds: string[] = []
  const roleIds: string[] = []
  let supplierId: string, hotelId: string, roomId: string, boardId: string, mappingId: string, contractId: string
  let n = 0

  const api = (cookie: string, tenant = tenantId) => {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => configure(request(app.getHttpServer()).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) => configure(request(app.getHttpServer()).patch(`/api/v1${path}`)).send(body),
      delete: (path: string) => configure(request(app.getHttpServer()).delete(`/api/v1${path}`)),
    }
  }
  const login = async (email: string) => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const lifecycle = async (cookie = maker) => (await api(cookie).get(`/supply/contracts/${contractId}/lifecycle`).expect(200)).body.data as {
    status: string; version: number; updatedAt: string; fingerprint: string; termsEditable: boolean; readiness: { ready: boolean; checks: Array<{ code: string; ok: boolean }> }
    openRequest: { id: string; status: string } | null; versions: Array<{ version: number; kind: string; approvedById: string; terms: { validTo: string; leadTimeRule: unknown } }>
  }
  const rid = () => `${suffix}-req-${++n}`
  const expectStatus = (r: request.Response, status: number) => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r }
  const requestActivation = async (cookie = maker) => api(cookie).post(`/supply/contracts/${contractId}/activation-request`, { requestId: rid(), reason: 'Signed 2026/27 contract loaded and checked', expectedFingerprint: (await lifecycle()).fingerprint })

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } }),
      prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-other` } }),
    ])
    tenantId = tenant.id; otherTenantId = other.id
    const passwordHash = await hashPassword(password)
    const users = await Promise.all(['maker', 'checker', 'readonly', 'outsider'].map((name) => prisma.user.create({ data: { email: `${suffix}-${name}@example.test`, passwordHash } })))
    userIds.push(...users.map((user) => user.id))
    const keys = ['hotels', 'rooms', 'rates', 'contracts', 'availability', 'suppliers', 'mappings'].flatMap((area) => [`supply.${area}.read`, `supply.${area}.manage`])
    const permissions = await Promise.all(keys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const grant = async (tenant: string, name: string, granted: typeof permissions) => {
      const role = await prisma.role.create({ data: { tenantId: tenant, name: `${suffix}-${name}` } })
      roleIds.push(role.id)
      await prisma.rolePermission.createMany({ data: granted.map((permission) => ({ roleId: role.id, permissionId: permission.id })) })
      return role.id
    }
    const makerRole = await grant(tenantId, 'maker', permissions)
    const checkerRole = await grant(tenantId, 'checker', permissions)
    const readOnlyRole = await grant(tenantId, 'readonly', permissions.filter((permission) => permission.key.endsWith('.read')))
    const outsiderRole = await grant(otherTenantId, 'outsider', permissions)
    await prisma.membership.createMany({ data: [{ tenantId, userId: userIds[0], role: 'owner' }, { tenantId, userId: userIds[1], role: 'member' }, { tenantId, userId: userIds[2], role: 'member' }, { tenantId: otherTenantId, userId: userIds[3], role: 'owner' }] })
    await prisma.userRole.createMany({ data: [{ tenantId, userId: userIds[0], roleId: makerRole }, { tenantId, userId: userIds[1], roleId: checkerRole }, { tenantId, userId: userIds[2], roleId: readOnlyRole }, { tenantId: otherTenantId, userId: userIds[3], roleId: outsiderRole }] })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    maker = await login(`${suffix}-maker@example.test`)
    checker = await login(`${suffix}-checker@example.test`)
    readOnly = await login(`${suffix}-readonly@example.test`)
    outsider = await login(`${suffix}-outsider@example.test`)

    supplierId = (await api(maker).post('/supply/suppliers', { type: 'DMC', status: 'ACTIVE', legalName: `${suffix} Supplier LLC`, displayName: 'Contract Supplier', countryCode: 'AE', defaultCurrency: 'AED' }).expect(201)).body.data.id
    hotelId = (await api(maker).post('/supply/hotels', { name: `${suffix} Hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', starRating: 4 }).expect(201)).body.data.id
    roomId = (await api(maker).post(`/supply/hotels/${hotelId}/rooms`, { name: 'Deluxe King', code: 'DLX', maxAdults: 2, maxChildren: 1, maxOccupancy: 3 }).expect(201)).body.data.id
    boardId = (await api(maker).post('/supply/board-bases', { code: 'BB', name: 'Bed & Breakfast' }).expect(201)).body.data.id
    mappingId = (await api(maker).post('/supply/mappings/hotels', { supplierId, hotelId, supplierHotelId: `${suffix}-SUP` }).expect(201)).body.data.id
    await api(maker).post(`/supply/mappings/hotels/${mappingId}/approve`).expect(201)
  }, 90000)

  afterAll(async () => {
    await app?.close()
    const tenants = [tenantId, otherTenantId]
    // History is immutable by design (trigger). The disposable database owner suspends triggers for this cleanup only.
    await prisma.$transaction([prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`), prisma.$executeRaw`DELETE FROM "ContractVersion" WHERE tenant_id = ANY(${tenants})`])
    const scope = { in: tenants }
    await prisma.auditEvent.deleteMany({ where: { tenantId: scope } })
    await prisma.approvalRequest.deleteMany({ where: { tenantId: scope } })
    await prisma.ratePlan.deleteMany({ where: { tenantId: scope } })
    await prisma.contract.deleteMany({ where: { tenantId: scope } })
    await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: scope } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: scope } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId: scope } } })
    await prisma.hotel.deleteMany({ where: { tenantId: scope } })
    await prisma.boardBasis.deleteMany({ where: { tenantId: scope } })
    await prisma.supplier.deleteMany({ where: { tenantId: scope } })
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: scope } })
    await prisma.$disconnect()
  })

  it('creates contracts in DRAFT only and never sets status through PATCH', async () => {
    const refusedCreate = await api(maker).post('/supply/contracts', { supplierId, supplierHotelMappingId: mappingId, code: `${suffix}-ACTIVE`, status: 'ACTIVE', validFrom: iso(-1), validTo: iso(365), settlementCurrency: 'AED' }).expect(400)
    expect(refusedCreate.body.error.code).toBe('CONTRACT_STATUS_VIA_LIFECYCLE_ONLY')
    contractId = (await api(maker).post('/supply/contracts', { supplierId, supplierHotelMappingId: mappingId, code: `${suffix}-C1`, validFrom: iso(-1), validTo: iso(365), settlementCurrency: 'AED' }).expect(201)).body.data.id
    await api(maker).post(`/supply/contracts/${contractId}/policies/cancellation`, { daysBeforeCheckin: 7, penaltyPercent: 100 }).expect(201)
    const refusedPatch = await api(maker).patch(`/supply/contracts/${contractId}`, { status: 'ACTIVE' }).expect(400)
    expect(refusedPatch.body.error.code).toBe('CONTRACT_STATUS_VIA_LIFECYCLE_ONLY')
    const view = await lifecycle()
    expect(view).toMatchObject({ status: 'DRAFT', version: 1, termsEditable: true, openRequest: null, versions: [] })
    expect(view.readiness.ready).toBe(true)
    expect(view.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('submit and return-to-draft are single-actor and version-guarded', async () => {
    const stale = await api(maker).post(`/supply/contracts/${contractId}/submit`, { expectedUpdatedAt: new Date(0).toISOString() })
    expectStatus(stale, 409)
    await api(readOnly).post(`/supply/contracts/${contractId}/submit`, { expectedUpdatedAt: (await lifecycle()).updatedAt }).expect(403)
    expectStatus(await api(maker).post(`/supply/contracts/${contractId}/submit`, { expectedUpdatedAt: (await lifecycle()).updatedAt }), 201)
    expect((await lifecycle()).status).toBe('REVIEW')
    expectStatus(await api(maker).post(`/supply/contracts/${contractId}/return-to-draft`, { expectedUpdatedAt: (await lifecycle()).updatedAt }), 201)
    expectStatus(await api(maker).post(`/supply/contracts/${contractId}/submit`, { expectedUpdatedAt: (await lifecycle()).updatedAt }), 201)
    const suspendDraft = await api(maker).post(`/supply/contracts/${contractId}/suspend`, { expectedUpdatedAt: (await lifecycle()).updatedAt, reason: 'x' })
    expect(expectStatus(suspendDraft, 409).body.error.code).toBe('CONTRACT_TRANSITION_NOT_ALLOWED')
  })

  it('files an activation request bound to the fingerprint; refuses stale terms, read-only users and other tenants', async () => {
    const stale = await api(maker).post(`/supply/contracts/${contractId}/activation-request`, { requestId: rid(), reason: 'r', expectedFingerprint: '0'.repeat(64) })
    expect(expectStatus(stale, 409).body.error.code).toBe('CONTRACT_CHANGED')
    await api(readOnly).post(`/supply/contracts/${contractId}/activation-request`, { requestId: rid(), reason: 'r', expectedFingerprint: (await lifecycle()).fingerprint }).expect(403)
    await api(outsider, otherTenantId).post(`/supply/contracts/${contractId}/activation-request`, { requestId: rid(), reason: 'r', expectedFingerprint: (await lifecycle()).fingerprint }).expect(404)
    const filed = expectStatus(await requestActivation(), 201).body.data
    expect(filed).toMatchObject({ kind: 'ACTIVATE', status: 'PENDING', isRequester: true, canDecide: false, canCancel: true })
    const again = await api(maker).post(`/supply/contracts/${contractId}/activation-request`, { requestId: rid(), reason: 'again', expectedFingerprint: (await lifecycle()).fingerprint })
    expect(expectStatus(again, 409).body.error.code).toBe('CONTRACT_APPROVAL_OPEN')
    expect((await lifecycle(checker)).openRequest).toMatchObject({ id: filed.id, status: 'PENDING' })
  })

  it('the maker cannot approve their own request; the checker approves', async () => {
    const open = (await lifecycle()).openRequest!
    await api(maker).post(`/supply/contract-approvals/${open.id}/approve`, { reason: 'self' }).expect(403)
    await api(readOnly).post(`/supply/contract-approvals/${open.id}/approve`, { reason: 'ro' }).expect(403)
    await api(outsider, otherTenantId).post(`/supply/contract-approvals/${open.id}/approve`, { reason: 'other tenant' }).expect(404)
    const approved = expectStatus(await api(checker).post(`/supply/contract-approvals/${open.id}/approve`, { reason: 'Terms match the signed contract' }), 201).body.data
    expect(approved).toMatchObject({ status: 'APPROVED', canExecute: true })
  })

  it('a term edited after approval voids it until the terms are exactly what was reviewed again', async () => {
    const open = (await lifecycle()).openRequest!
    const band = (await api(maker).post(`/supply/contracts/${contractId}/policies/child`, { minAge: 0, maxAge: 5, extraBedAllowed: false }).expect(201)).body.data.id
    const voided = await api(maker).post(`/supply/contract-approvals/${open.id}/execute`)
    expect(expectStatus(voided, 409).body.error.code).toBe('CONTRACT_CHANGED_SINCE_APPROVAL')
    expect((await lifecycle()).status).toBe('REVIEW')
    await api(maker).delete(`/supply/contracts/${contractId}/policies/child/${band}`).expect(200)
    expect((await lifecycle()).openRequest).toMatchObject({ id: open.id, status: 'APPROVED' })
  })

  it('activates exactly once, writes snapshot v1 with requester and approver, and cannot be replayed', async () => {
    const open = (await lifecycle()).openRequest!
    const [a, b] = await Promise.all([api(maker).post(`/supply/contract-approvals/${open.id}/execute`), api(checker).post(`/supply/contract-approvals/${open.id}/execute`)])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const view = await lifecycle()
    expect(view).toMatchObject({ status: 'ACTIVE', version: 1, termsEditable: false })
    expect(view.versions).toHaveLength(1)
    expect(view.versions[0]).toMatchObject({ version: 1, kind: 'ACTIVATION', approvedById: userIds[1] })
    const audits = await prisma.auditEvent.findMany({ where: { tenantId, entityId: contractId, action: 'supply.contract.status_changed' } })
    expect(audits.some((e) => (e.payload as { to?: string; approvedById?: string }).to === 'ACTIVE' && (e.payload as { approvedById?: string }).approvedById === userIds[1])).toBe(true)
    await api(maker).post(`/supply/contract-approvals/${open.id}/execute`).expect(409)
  })

  it('locks every term of an ACTIVE contract: header, policies and their deletion', async () => {
    const policies = (await api(maker).get(`/supply/contracts/${contractId}/policies`).expect(200)).body.data
    for (const r of [
      await api(maker).patch(`/supply/contracts/${contractId}`, { validTo: iso(400) }),
      await api(maker).post(`/supply/contracts/${contractId}/policies/cancellation`, { daysBeforeCheckin: 1, penaltyPercent: 50 }),
      await api(maker).post(`/supply/contracts/${contractId}/policies/lead-time`, { minLeadHours: 24 }),
      await api(maker).delete(`/supply/contracts/${contractId}/policies/cancellation/${policies.cancellationPolicies[0].id}`),
    ]) expect(expectStatus(r, 409).body.error.code).toBe('CONTRACT_TERMS_LOCKED')
  })

  it('amends an ACTIVE contract only through an approved amendment that raises the version', async () => {
    await api(maker).post('/supply/rate-plans', { contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-P1`, occupancy: 2, currency: 'AED', refundable: true }).expect(201)
    const fingerprint = (await lifecycle()).fingerprint
    const identity = await api(maker).post(`/supply/contracts/${contractId}/amendment-request`, { requestId: rid(), reason: 'r', expectedFingerprint: fingerprint, changes: { supplierId: 'x' } })
    expect(expectStatus(identity, 400).body.error.code).toBe('CONTRACT_AMENDMENT_INVALID')
    const conflict = await api(maker).post(`/supply/contracts/${contractId}/amendment-request`, { requestId: rid(), reason: 'r', expectedFingerprint: fingerprint, changes: { settlementCurrency: 'USD' } })
    expect([400, 409]).toContain(conflict.status)

    const changes = { validTo: iso(450), leadTimeRule: { minLeadHours: 48, maxLeadDays: null }, cancellationPolicies: [{ daysBeforeCheckin: 14, penaltyPercent: 50 }, { daysBeforeCheckin: 3, penaltyPercent: 100 }] }
    const filed = expectStatus(await api(maker).post(`/supply/contracts/${contractId}/amendment-request`, { requestId: rid(), reason: 'Hotel extended the contract and added a 14-day tier', expectedFingerprint: fingerprint, changes }), 201).body.data
    expect(filed).toMatchObject({ kind: 'AMEND', status: 'PENDING', changes: { validTo: iso(450) } })
    // Filing changes nothing until applied.
    expect((await lifecycle()).version).toBe(1)
    await api(maker).post(`/supply/contract-approvals/${filed.id}/approve`, { reason: 'self' }).expect(403)
    expectStatus(await api(checker).post(`/supply/contract-approvals/${filed.id}/approve`, { reason: 'Matches the addendum' }), 201)
    const done = expectStatus(await api(maker).post(`/supply/contract-approvals/${filed.id}/execute`), 201).body.data
    expect(done).toMatchObject({ status: 'ACTIVE', version: 2 })
    const view = await lifecycle()
    expect(view.versions.map((v) => [v.version, v.kind])).toEqual([[2, 'AMENDMENT'], [1, 'ACTIVATION']])
    expect(view.versions[0]!.terms).toMatchObject({ validTo: iso(450), leadTimeRule: { minLeadHours: 48, maxLeadDays: null } })
    const stored = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, include: { cancellationPolicies: true, leadTimeRules: true } })
    expect(stored.validTo.toISOString().slice(0, 10)).toBe(iso(450))
    expect(stored.cancellationPolicies.map((p) => [p.daysBeforeCheckin, p.penaltyPercent]).sort()).toEqual([[14, 50], [3, 100]].sort())
    const amended = await prisma.auditEvent.findFirst({ where: { tenantId, entityId: contractId, action: 'supply.contract.amended' } })
    expect(amended?.payload).toMatchObject({ fromVersion: 1, toVersion: 2, approvedById: userIds[1] })
  })

  it('suspension is single-actor with a reason; reactivation needs approval and raises the version only if the terms changed', async () => {
    await api(maker).post(`/supply/contracts/${contractId}/suspend`, { expectedUpdatedAt: (await lifecycle()).updatedAt }).expect(400)
    expectStatus(await api(maker).post(`/supply/contracts/${contractId}/suspend`, { expectedUpdatedAt: (await lifecycle()).updatedAt, reason: 'Hotel under renovation' }), 201)
    expect((await lifecycle()).termsEditable).toBe(true)
    await api(maker).post(`/supply/contracts/${contractId}/policies/child`, { minAge: 0, maxAge: 11, extraBedAllowed: true }).expect(201)
    const filed = expectStatus(await requestActivation(), 201).body.data
    expectStatus(await api(checker).post(`/supply/contract-approvals/${filed.id}/approve`, { reason: 'Child policy confirmed' }), 201)
    expect(expectStatus(await api(maker).post(`/supply/contract-approvals/${filed.id}/execute`), 201).body.data).toMatchObject({ status: 'ACTIVE', version: 3 })
  })

  it('history rows are immutable even for the database owner', async () => {
    const row = await prisma.contractVersion.findFirstOrThrow({ where: { contractId, version: 1 } })
    await expect(prisma.contractVersion.update({ where: { id: row.id }, data: { reason: 'rewritten' } })).rejects.toThrow(/immutable/)
    await expect(prisma.contractVersion.delete({ where: { id: row.id } })).rejects.toThrow(/immutable/)
  })
})
