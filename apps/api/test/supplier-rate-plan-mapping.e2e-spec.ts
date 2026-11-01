import { randomBytes } from 'crypto'
import { PrismaService } from '../src/database/prisma.service'
import { resolveAllotment, resolveCancellation, resolveRate, summarizeResolutions } from '../src/mapping/observation-resolution'
import { MappingService } from '../src/supply/mapping.service'
import { loadMappingIndex } from '../src/supply/mapping-index.loader'
import { RatePlanMappingService } from '../src/supply/rate-plan-mapping.service'
import { assertRatesNotFeedManaged, feedManagedPlanIds } from '../src/supply/feed-managed'

jest.setTimeout(120_000)

/** ADR 0081: governed supplier rate plan mappings and the resolution of ingested observations through them (PostgreSQL). */
describe('supplier rate plan mapping governance and resolution', () => {
  const prisma = new PrismaService()
  const mappings = new MappingService(prisma)
  const service = new RatePlanMappingService(prisma)
  const suffix = `rpm-${Date.now()}-${randomBytes(3).toString('hex')}`
  const day = (o: number) => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime() + o * 86_400_000
  let tenantId = '', otherTenantId = '', userId = '', readerId = '', supplierId = '', otherSupplierId = ''
  let hotelId = '', roomId = '', otherRoomId = '', hotelMappingId = '', roomMappingId = ''
  let planA = '', planB = '', planOtherRoom = '', planOtherSupplier = '', planDerived = '', planOtherTenant = ''
  const now = new Date()
  const later = new Date(now.getTime() + 3_600_000)

  async function plan(tenant: string, supplier: string, room: string, code: string, extra: Record<string, unknown> = {}) {
    const board = await prisma.boardBasis.upsert({ where: { tenantId_code: { tenantId: tenant, code: 'BB' } }, update: {}, create: { tenantId: tenant, code: 'BB', name: 'B&B' } })
    const parent = typeof extra.derivedFromId === 'string' ? await prisma.ratePlan.findUniqueOrThrow({ where: { id: extra.derivedFromId }, select: { contractId: true } }) : null
    const contract = parent ? { id: parent.contractId } : await prisma.contract.create({ data: { tenantId: tenant, supplierId: supplier, code: `${suffix}-${code}`, status: 'ACTIVE', validFrom: new Date(day(-5)), validTo: new Date(day(300)), settlementCurrency: 'AED' } as never })
    return (await prisma.ratePlan.create({ data: { tenantId: tenant, contractId: contract.id, roomTypeId: room, boardBasisId: board.id, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', ...extra } })).id
  }

  beforeAll(async () => {
    await prisma.$connect()
    const tenant = (name: string) => prisma.tenant.create({ data: { name: `${suffix} ${name}`, slug: `${suffix}-${name}` } }).then((t) => t.id)
    tenantId = await tenant('a'); otherTenantId = await tenant('b')
    userId = (await prisma.user.create({ data: { email: `${suffix}-m@example.test` } })).id
    readerId = (await prisma.user.create({ data: { email: `${suffix}-r@example.test` } })).id
    const perms = await Promise.all(['supply.mappings.read', 'supply.mappings.manage'].map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const grant = async (user: string, name: string, keys: string[]) => {
      const role = await prisma.role.create({ data: { tenantId, name: `${suffix}-${name}` } })
      await prisma.rolePermission.createMany({ data: perms.filter((p) => keys.includes(p.key)).map((p) => ({ roleId: role.id, permissionId: p.id })) })
      await prisma.userRole.create({ data: { tenantId, userId: user, roleId: role.id } })
    }
    await prisma.membership.createMany({ data: [{ tenantId, userId, role: 'member' }, { tenantId, userId: readerId, role: 'member' }] })
    await grant(userId, 'manager', ['supply.mappings.read', 'supply.mappings.manage']); await grant(readerId, 'reader', ['supply.mappings.read'])
    const sup = (t: string, n: string) => prisma.supplier.create({ data: { tenantId: t, type: 'DMC', legalName: `${suffix} ${n}`, displayName: n, countryCode: 'AE', defaultCurrency: 'AED' } as never }).then((s) => s.id)
    supplierId = await sup(tenantId, 'S1'); otherSupplierId = await sup(tenantId, 'S2'); const supplierB = await sup(otherTenantId, 'SB')
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} H`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4 } })).id
    const hotelB = (await prisma.hotel.create({ data: { tenantId: otherTenantId, name: `${suffix} HB`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 4 } })).id
    const room = (h: string, code: string) => prisma.roomType.create({ data: { hotelId: h, name: code, code, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } }).then((r) => r.id)
    roomId = await room(hotelId, 'DLX'); otherRoomId = await room(hotelId, 'STD'); const roomB = await room(hotelB, 'DLXB')
    planA = await plan(tenantId, supplierId, roomId, 'A'); planB = await plan(tenantId, supplierId, roomId, 'B')
    planOtherRoom = await plan(tenantId, supplierId, otherRoomId, 'C'); planOtherSupplier = await plan(tenantId, otherSupplierId, roomId, 'D')
    planDerived = await plan(tenantId, supplierId, roomId, 'E', { derivedFromId: planA, derivedMode: 'PERCENT_BP', derivedAdjustment: -1000 })
    planOtherTenant = await plan(otherTenantId, supplierB, roomB, 'F')

    hotelMappingId = (await mappings.createHotel(tenantId, userId, { supplierId, hotelId, supplierHotelId: 'H1' })).id
    roomMappingId = (await mappings.createRoom(tenantId, userId, hotelMappingId, { supplierRoomId: 'DBL', roomTypeId: roomId })).id
  })

  afterAll(async () => {
    for (const t of [tenantId, otherTenantId]) {
      await prisma.supplierRatePlanMapping.deleteMany({ where: { tenantId: t } })
      await prisma.auditEvent.deleteMany({ where: { tenantId: t } })
      await prisma.dailyRate.deleteMany({ where: { tenantId: t } })
      await prisma.ratePlan.deleteMany({ where: { tenantId: t, derivedFromId: { not: null } } })
      await prisma.ratePlan.deleteMany({ where: { tenantId: t } })
      await prisma.contract.deleteMany({ where: { tenantId: t } })
      await prisma.boardBasis.deleteMany({ where: { tenantId: t } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: t } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: t } })
      await prisma.roomType.deleteMany({ where: { hotel: { tenantId: t } } })
      await prisma.hotel.deleteMany({ where: { tenantId: t } })
      await prisma.supplier.deleteMany({ where: { tenantId: t } })
      await prisma.userRole.deleteMany({ where: { tenantId: t } })
      await prisma.role.deleteMany({ where: { tenantId: t } })
      await prisma.membership.deleteMany({ where: { tenantId: t } })
    }
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.user.deleteMany({ where: { email: { startsWith: suffix } } })
    await prisma.$disconnect()
  })

  const create = (code: string, ratePlanId: string, user = userId, tenant = tenantId) => service.create(tenant, user, hotelMappingId, roomMappingId, { supplierRatePlanCode: code, ratePlanId })

  it('RPM-01 creates PENDING mappings only for a plan of the mapped room type and supplier; derived and foreign plans are refused; permissions are enforced', async () => {
    const options = await service.options(tenantId, readerId, hotelMappingId, roomMappingId)
    expect(options.map((o) => o.code).sort()).toEqual(['A', 'B'])
    await expect(create('X', planOtherRoom)).rejects.toThrow(/mapped room type/)
    await expect(create('X', planOtherSupplier)).rejects.toThrow(/mapped supplier/)
    await expect(create('X', planDerived)).rejects.toThrow(/derived/)
    await expect(create('X', planOtherTenant)).rejects.toThrow(/mapped room type/)
    await expect(create('bad code!', planA)).rejects.toThrow(/Invalid supplierRatePlanCode/)
    await expect(create('X', planA, readerId)).rejects.toThrow(/Insufficient permission/)
    await expect(service.list(otherTenantId, userId, hotelMappingId, roomMappingId)).rejects.toThrow(/Insufficient permission/)
    const m = await create('BAR', planA)
    expect(m).toMatchObject({ supplierRatePlanCode: 'BAR', ratePlanId: planA, ratePlanCode: 'A', currency: 'AED', status: 'PENDING' })
    await expect(create('BAR', planB)).rejects.toMatchObject({ response: { code: 'SUPPLIER_RATE_PLAN_MAPPING_CONFLICT' } })
    await expect(create('OTHER', planA)).rejects.toMatchObject({ response: { code: 'SUPPLIER_RATE_PLAN_MAPPING_CONFLICT' } })
    expect((await service.options(tenantId, readerId, hotelMappingId, roomMappingId)).map((o) => o.code)).toEqual(['B'])
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'supply.rate_plan_mapping.created', entityId: m.id } })).toBe(1)
  })

  it('RPM-02 approval needs the room mapping approved first; the lifecycle audits each step; a room cannot leave MAPPED while a plan depends on it', async () => {
    const [pending] = await service.list(tenantId, readerId, hotelMappingId, roomMappingId)
    await expect(service.decide(tenantId, userId, hotelMappingId, roomMappingId, pending.id, 'approve')).rejects.toThrow(/Approve the room mapping first/)
    await mappings.decide(tenantId, userId, 'hotel', hotelMappingId, 'approve', undefined)
    await mappings.decide(tenantId, userId, 'room', roomMappingId, 'approve', undefined, hotelMappingId)
    await expect(service.decide(tenantId, userId, hotelMappingId, roomMappingId, pending.id, 'reopen')).rejects.toThrow(/Invalid mapping transition/)
    await expect(service.decide(tenantId, readerId, hotelMappingId, roomMappingId, pending.id, 'approve')).rejects.toThrow(/Insufficient permission/)
    expect(await service.decide(tenantId, userId, hotelMappingId, roomMappingId, pending.id, 'approve', 'verified against contract sheet')).toMatchObject({ status: 'MAPPED' })
    await expect(mappings.decide(tenantId, userId, 'room', roomMappingId, 'reopen', undefined, hotelMappingId)).rejects.toThrow(/Reopen approved rate plan mappings first/)
    // The database refuses the same thing even if the service were bypassed.
    await expect(prisma.supplierRoomMapping.update({ where: { id: roomMappingId }, data: { status: 'PENDING' } })).rejects.toThrow(/Reopen the approved rate plan mappings/)
    const audit = await prisma.auditEvent.findMany({ where: { tenantId, entityId: pending.id }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((a) => a.action)).toEqual(['supply.rate_plan_mapping.created', 'supply.rate_plan_mapping.approved'])
    expect(audit[1].payload).toMatchObject({ previousStatus: 'PENDING', newStatus: 'MAPPED', reason: 'verified against contract sheet', supplierRatePlanCode: 'BAR' })
  })

  it('RPM-02b an approved mapping makes its plan feed-managed (single writer); pending, reopened and other tenants do not', async () => {
    // BAR is MAPPED (planA) and PROMO does not exist yet: only the approved mapping manages a plan.
    expect(await prisma.withTenant(tenantId, (tx) => feedManagedPlanIds(tx, tenantId, [planA, planB]))).toEqual([planA])
    await expect(prisma.withTenant(tenantId, (tx) => assertRatesNotFeedManaged(tx, tenantId, [planA, planB]))).rejects.toMatchObject({ response: { code: 'RATE_PLAN_FEED_MANAGED', ratePlanIds: [planA] } })
    await expect(prisma.withTenant(tenantId, (tx) => assertRatesNotFeedManaged(tx, tenantId, [planB]))).resolves.toBeUndefined()
    await expect(prisma.withTenant(tenantId, (tx) => assertRatesNotFeedManaged(tx, tenantId, []))).resolves.toBeUndefined()
    expect(await prisma.withTenant(otherTenantId, (tx) => feedManagedPlanIds(tx, otherTenantId, [planA]))).toEqual([])
  })

  it('RPM-03 database guards: identity is immutable and the plan must match the room type, supplier and tenant even when the service is bypassed', async () => {
    const [mapped] = await service.list(tenantId, readerId, hotelMappingId, roomMappingId)
    await expect(prisma.supplierRatePlanMapping.update({ where: { id: mapped.id }, data: { supplierRatePlanCode: 'RENAMED' } })).rejects.toThrow(/identity is immutable/)
    await expect(prisma.supplierRatePlanMapping.update({ where: { id: mapped.id }, data: { ratePlanId: planB } })).rejects.toThrow(/identity is immutable/)
    const raw = (ratePlanId: string, tenant = tenantId) => prisma.supplierRatePlanMapping.create({ data: { tenantId: tenant, supplierRoomMappingId: roomMappingId, supplierRatePlanCode: `RAW-${randomBytes(3).toString('hex')}`, ratePlanId } })
    await expect(raw(planOtherRoom)).rejects.toThrow(/not of the mapped room type/)
    await expect(raw(planOtherSupplier)).rejects.toThrow(/another supplier/)
    await expect(raw(planOtherTenant)).rejects.toThrow(/Foreign key|same tenant/i)
    await expect(raw(planB, otherTenantId)).rejects.toThrow(/same tenant|Foreign key/i)
    await expect(prisma.supplierRatePlanMapping.create({ data: { tenantId, supplierRoomMappingId: roomMappingId, supplierRatePlanCode: 'OK-1', ratePlanId: planB, confidence: 101 } })).rejects.toThrow(/check constraint|violat/i)
  })

  it('RPM-04 the loaded index resolves rates, allotments and cancellation policies only through approved mappings, and feeds the review list', async () => {
    const index = await prisma.withTenant(tenantId, (tx) => loadMappingIndex(tx, tenantId, supplierId))
    const rate = (patch: object = {}) => ({ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: 'BAR', currency: 'AED', taxesIncluded: true as boolean | null, freshUntil: later, ...patch })
    expect(resolveRate(rate(), index, now)).toMatchObject({ ok: true, target: { hotelId, roomTypeId: roomId, ratePlanId: planA } })
    expect(resolveAllotment({ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: '', freshUntil: later }, index, now)).toMatchObject({ ok: true, target: { ratePlanId: null } })
    expect(resolveCancellation({ supplierHotelCode: 'H1', supplierRoomCode: '', supplierRatePlanCode: 'BAR', freshUntil: later }, index, now)).toMatchObject({ ok: true, target: { plans: [{ ratePlanId: planA }] } })
    // A second code is mapped but still PENDING: reported as not approved, not as unmapped.
    await create('PROMO', planB)
    const withPending = await prisma.withTenant(tenantId, (tx) => loadMappingIndex(tx, tenantId, supplierId))
    expect(resolveRate(rate({ supplierRatePlanCode: 'PROMO' }), withPending, now)).toMatchObject({ ok: false, reason: 'RATE_PLAN_NOT_APPROVED' })
    expect(resolveRate(rate({ supplierRatePlanCode: 'NOPE' }), withPending, now)).toMatchObject({ ok: false, reason: 'RATE_PLAN_UNMAPPED' })
    const summary = summarizeResolutions([rate(), rate({ supplierRatePlanCode: 'NOPE' }), rate({ supplierRoomCode: 'TWIN' })].map((o) => ({ hotel: o.supplierHotelCode, room: o.supplierRoomCode, plan: o.supplierRatePlanCode, resolution: resolveRate(o, withPending, now) })))
    expect(summary).toMatchObject({ resolved: 1, unresolved: 2 })
    expect(summary.unmapped.map((u) => u.reason).sort()).toEqual(['RATE_PLAN_UNMAPPED', 'ROOM_UNMAPPED'])
    // Another supplier's index and another tenant see none of these mappings.
    expect(resolveRate(rate(), await prisma.withTenant(tenantId, (tx) => loadMappingIndex(tx, tenantId, otherSupplierId)), now)).toMatchObject({ reason: 'HOTEL_UNMAPPED' })
    expect(resolveRate(rate(), await prisma.withTenant(otherTenantId, (tx) => loadMappingIndex(tx, otherTenantId, supplierId)), now)).toMatchObject({ reason: 'HOTEL_UNMAPPED' })
  })

  it('RPM-05 rejecting or reopening an approved mapping stops it resolving at once', async () => {
    const [bar] = (await service.list(tenantId, readerId, hotelMappingId, roomMappingId)).filter((m) => m.supplierRatePlanCode === 'BAR')
    await service.decide(tenantId, userId, hotelMappingId, roomMappingId, bar.id, 'reopen')
    const index = await prisma.withTenant(tenantId, (tx) => loadMappingIndex(tx, tenantId, supplierId))
    expect(resolveRate({ supplierHotelCode: 'H1', supplierRoomCode: 'DBL', supplierRatePlanCode: 'BAR', currency: 'AED', taxesIncluded: true, freshUntil: later }, index, now)).toMatchObject({ ok: false, reason: 'RATE_PLAN_NOT_APPROVED' })
    // Reopening hands the plan back to people.
    await expect(prisma.withTenant(tenantId, (tx) => assertRatesNotFeedManaged(tx, tenantId, [planA]))).resolves.toBeUndefined()
    // With no approved plan left the room mapping may now be reopened.
    await mappings.decide(tenantId, userId, 'room', roomMappingId, 'reopen', undefined, hotelMappingId)
  })
})
