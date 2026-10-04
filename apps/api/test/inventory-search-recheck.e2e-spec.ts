import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { PrismaService } from '../src/database/prisma.service'
import { ContractedInventoryAdapter } from '../src/agent/contracted-inventory.adapter'

/** Search and recheck use the one canonical evaluator against real inventory rows (PostgreSQL). */
describe('authoritative search and recheck over inventory (PostgreSQL)', () => {
  const prisma = new PrismaService()
  const adapter = new ContractedInventoryAdapter(prisma)
  const suffix = `sr-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const checkIn = day(20); const mid = day(21); const checkOut = day(22)
  const nights = [checkIn, mid]
  let tenantId: string, otherTenantId: string, userId: string, supplierId: string, hotelId: string, roomId: string, boardId: string, contractId: string, poolId: string
  let ctx: { tenantId: string; requestId: string }

  const criteria = (patch: Partial<SearchCriteria> = {}): SearchCriteria => ({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED', ...patch })

  async function newPlan(code: string, opts: { poolId?: string; releaseDays?: number; releaseTimeLocal?: string; allotment?: number; basis?: 'SELL'; amount?: bigint; rows?: boolean; mode?: 'ALLOTMENT' | 'FREE_SALE' | 'ON_REQUEST' | 'CLOSED' } = {}): Promise<string> {
    const id = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-${code}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', releaseDays: opts.releaseDays ?? 0, releaseTimeLocal: opts.releaseTimeLocal ?? '00:00', inventoryPoolId: opts.poolId ?? null } })).id
    await prisma.dailyRate.createMany({ data: nights.map((d) => ({ tenantId, ratePlanId: id, stayDate: new Date(d), occupancy: 2, amountMinor: opts.amount ?? 50000n, amountBasis: 'SELL' as const, currency: 'AED' })) })
    if (opts.rows !== false) {
      await prisma.dailyAvailability.createMany({ data: [...nights, checkOut].map((d) => ({ tenantId, ratePlanId: id, stayDate: new Date(d), allotment: opts.allotment ?? 5, inventoryMode: opts.mode ?? 'ALLOTMENT' })) })
    }
    return id
  }
  const rates = async (c = criteria(), tenant = tenantId): Promise<SearchRateOffer[]> => {
    const result = await adapter.search(c, { tenantId: tenant, requestId: 'r' })
    return result.offers.flatMap((h) => h.rooms.flatMap((r) => r.rates))
  }
  const forPlan = (list: SearchRateOffer[], planId: string) => list.find((r) => r.ratePlanId === planId)
  const resetPlans = async () => {
    await prisma.dailyAvailability.deleteMany({ where: { tenantId } }); await prisma.dailyRate.deleteMany({ where: { tenantId } })
    await prisma.ratePlan.deleteMany({ where: { tenantId } })
  }

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    userId = (await prisma.user.create({ data: { email: `${suffix}@example.test` } })).id
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} hotel`, propertyType: 'HOTEL', starRating: 5, city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE' } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Room', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'ROH', name: `ROH ${suffix}` } })).id
    const hm = (await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: `${suffix}-sh`, status: 'MAPPED' } })).id
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: hm, hotelId, supplierRoomId: `${suffix}-sr`, roomTypeId: roomId, status: 'MAPPED' } })
    contractId = (await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: hm, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    poolId = (await prisma.inventoryPool.create({ data: { tenantId, hotelId, supplierId, name: 'Shared', createdById: userId } })).id
    ctx = { tenantId, requestId: 'r' }
  })

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } }); await prisma.inventoryHold.deleteMany({ where: { tenantId } })
    await resetPlans()
    await prisma.inventoryPoolDay.deleteMany({ where: { tenantId } }); await prisma.inventoryPool.deleteMany({ where: { tenantId } })
    await prisma.contract.deleteMany({ where: { tenantId } }); await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } }); await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
    await prisma.boardBasis.deleteMany({ where: { tenantId } }); await prisma.roomType.deleteMany({ where: { hotelId } }); await prisma.hotel.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } }); await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.user.delete({ where: { id: userId } }); await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.$disconnect()
  })
  afterEach(resetPlans)

  it('SR-01 allotment shows available, then limited when remaining is at or below the requested rooms; sold out disappears', async () => {
    const plan = await newPlan('a', { allotment: 5 })
    expect(forPlan(await rates(), plan)).toMatchObject({ availability: 'available', available: true })
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: plan }, data: { sold: 4 } })
    expect(forPlan(await rates(), plan)).toMatchObject({ availability: 'limited', available: true })
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: plan }, data: { sold: 5 } })
    expect(forPlan(await rates(), plan)).toBeUndefined()
  })

  it('SR-02 a shared pool is one stock: three plans over capacity 1 all show limited, and an exhausted pool hides all three', async () => {
    await prisma.inventoryPoolDay.createMany({ data: nights.map((d) => ({ tenantId, poolId, stayDate: new Date(d), capacity: 1 })) })
    const plans = [await newPlan('p1', { poolId, allotment: 9 }), await newPlan('p2', { poolId, allotment: 9 }), await newPlan('p3', { poolId, allotment: 9 })]
    let list = await rates()
    for (const p of plans) expect(forPlan(list, p)).toMatchObject({ availability: 'limited', available: true })
    await prisma.inventoryPoolDay.updateMany({ where: { poolId }, data: { held: 1 } })
    list = await rates()
    for (const p of plans) expect(forPlan(list, p)).toBeUndefined()
    await prisma.inventoryPoolDay.deleteMany({ where: { poolId } })
  })

  it('SR-03 a missing pool day is not zero and not fabricated: the offer is absent', async () => {
    await prisma.inventoryPoolDay.create({ data: { tenantId, poolId, stayDate: new Date(checkIn), capacity: 5 } }) // second night missing
    const plan = await newPlan('p', { poolId })
    expect(forPlan(await rates(), plan)).toBeUndefined()
    await prisma.inventoryPoolDay.deleteMany({ where: { poolId } })
  })

  it('SR-04 FREE_SALE is available with no counted stock; ON_REQUEST is visible but never available and never rechecks as held', async () => {
    const free = await newPlan('free', { mode: 'FREE_SALE', allotment: 0 })
    expect(forPlan(await rates(), free)).toMatchObject({ availability: 'available', available: true })
    await prisma.dailyAvailability.deleteMany({ where: { tenantId } }); await prisma.dailyRate.deleteMany({ where: { tenantId } }); await prisma.ratePlan.deleteMany({ where: { tenantId } })
    const req = await newPlan('req', { mode: 'ON_REQUEST' })
    const offer = forPlan(await rates(), req)
    expect(offer).toMatchObject({ availability: 'on_request', available: false })
    expect(await adapter.recheck({ offerId: offer!.offerId, searchId: 's' }, { ...ctx, userId })).toEqual({ status: 'unavailable' })
  })

  it('SR-05 CLOSED, stop sell, stale, CTA, and CTD on the departure date all remove the offer; CTD on a stay-through night does not', async () => {
    const plan = await newPlan('x')
    const row = (d: string) => ({ ratePlanId_stayDate: { ratePlanId: plan, stayDate: new Date(d) } })
    const expectGone = async (label: string) => { expect(forPlan(await rates(), plan)).toBeUndefined(); void label }
    await prisma.dailyAvailability.update({ where: row(mid), data: { inventoryMode: 'CLOSED' } }); await expectGone('closed')
    await prisma.dailyAvailability.update({ where: row(mid), data: { inventoryMode: 'ALLOTMENT', stopSell: true } }); await expectGone('stop sell')
    await prisma.dailyAvailability.update({ where: row(mid), data: { stopSell: false, source: 'SUPPLIER_API', freshUntil: null } }); await expectGone('stale supplier')
    await prisma.dailyAvailability.update({ where: row(mid), data: { source: 'ADMIN' } })
    await prisma.dailyAvailability.update({ where: row(checkIn), data: { closedToArrival: true } }); await expectGone('cta')
    await prisma.dailyAvailability.update({ where: row(checkIn), data: { closedToArrival: false } })
    await prisma.dailyAvailability.update({ where: row(mid), data: { closedToDeparture: true } })
    expect(forPlan(await rates(), plan)).toBeDefined() // CTD on a stay-through night
    await prisma.dailyAvailability.update({ where: row(mid), data: { closedToDeparture: false } })
    await prisma.dailyAvailability.update({ where: row(checkOut), data: { closedToDeparture: true } }); await expectGone('ctd on departure')
  })

  it('SR-06 the release rule is hotel-local: a plan needing 25 days is hidden at 20 days; 19 passes', async () => {
    const hidden = await newPlan('late', { releaseDays: 25 })
    const ok = await newPlan('ok', { releaseDays: 19 })
    const list = await rates()
    expect(forPlan(list, hidden)).toBeUndefined(); expect(forPlan(list, ok)).toBeDefined()
  })

  it('SR-07 recheck never allocates and reflects inventory changes: rechecked while stock lasts, unavailable once gone', async () => {
    const plan = await newPlan('rc', { allotment: 1 })
    const offer = forPlan(await rates(), plan)!
    const before = await prisma.dailyAvailability.aggregate({ where: { ratePlanId: plan }, _sum: { held: true, sold: true } })
    const ok = await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })
    expect(ok).toMatchObject({ status: 'available', offer: { ratePlanId: plan, supplierId, canonicalHotelId: hotelId, canonicalRoomTypeId: roomId, boardBasisId: boardId, sellAmountMinor: offer.sellAmountMinor } })
    expect(await prisma.dailyAvailability.aggregate({ where: { ratePlanId: plan }, _sum: { held: true, sold: true } })).toEqual(before)
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: plan }, data: { sold: 1 } })
    expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })).toEqual({ status: 'unavailable' })
  })

  it('SR-08 recheck reports a changed price and an unknown or foreign offer as unavailable, never as a different product', async () => {
    const plan = await newPlan('pc')
    const offer = forPlan(await rates(), plan)!
    await prisma.dailyRate.updateMany({ where: { ratePlanId: plan }, data: { amountMinor: 60000n } })
    const changed = await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })
    expect(changed).toMatchObject({ status: 'available', offer: { ratePlanId: plan, sellAmountMinor: 120000 } })
    expect(offer.sellAmountMinor).toBe(100000)
    expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { tenantId: otherTenantId, userId, requestId: 'r' })).toEqual({ status: 'unavailable' })
    expect(await adapter.recheck({ offerId: 'nope', searchId: 's' }, { ...ctx, userId })).toEqual({ status: 'unavailable' })
  })

  it('SR-09 a plan with no availability rows is absent, not priced from zero or fabricated', async () => {
    const plan = await newPlan('norows', { rows: false })
    expect(forPlan(await rates(), plan)).toBeUndefined()
  })

  it('SR-10 another tenant sees none of this inventory', async () => {
    await newPlan('t')
    expect(await rates(criteria(), otherTenantId).catch(() => [])).toEqual([])
  })

  it('SR-11 recheck never substitutes a sibling: when the offered plan stops selling, an available sibling of the same room and board is not returned in its place', async () => {
    const offered = await newPlan('offered'); const sibling = await newPlan('sibling')
    const list = await rates(); const offer = forPlan(list, offered)!
    expect(forPlan(list, sibling)).toBeDefined()
    await prisma.ratePlan.update({ where: { id: offered }, data: { status: 'SUSPENDED' } })
    expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })).toEqual({ status: 'unavailable' })
    await prisma.ratePlan.update({ where: { id: offered }, data: { status: 'ACTIVE' } })
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: offered }, data: { inventoryMode: 'CLOSED' } })
    expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })).toEqual({ status: 'unavailable' })
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: offered }, data: { inventoryMode: 'ALLOTMENT' } })
    const ok = await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })
    expect(ok).toMatchObject({ status: 'available', offer: { ratePlanId: offered, supplierId, canonicalRoomTypeId: roomId, boardBasisId: boardId } })
  })
})
