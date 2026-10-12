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

  async function newPlan(code: string, opts: { poolId?: string; releaseDays?: number; releaseTimeLocal?: string; allotment?: number; basis?: 'SELL' | 'NET'; amount?: bigint; rows?: boolean; validFrom?: string; validTo?: string; paymentType?: 'PREPAID' | 'PAY_AT_HOTEL'; cancellationPolicySet?: string; occupancy?: number; guestPrices?: Array<{ kind: 'CHILD' | 'EXTRA_ADULT'; minAge: number; maxAge: number; amountMinor: bigint; basis: 'NET' | 'SELL' }>; salesMarkets?: string[]; nationalities?: string[]; mode?: 'ALLOTMENT' | 'FREE_SALE' | 'ON_REQUEST' | 'CLOSED' } = {}): Promise<string> {
    const id = (await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-${code}`, status: 'ACTIVE', occupancy: opts.occupancy ?? 2, currency: 'AED', releaseDays: opts.releaseDays ?? 0, releaseTimeLocal: opts.releaseTimeLocal ?? '00:00', inventoryPoolId: opts.poolId ?? null, validFrom: opts.validFrom ? new Date(opts.validFrom) : null, validTo: opts.validTo ? new Date(opts.validTo) : null, paymentType: opts.paymentType ?? null, cancellationPolicySet: opts.cancellationPolicySet ?? null, salesMarkets: opts.salesMarkets ?? [], nationalities: opts.nationalities ?? [] } })).id
    await prisma.dailyRate.createMany({ data: nights.map((d) => ({ tenantId, ratePlanId: id, stayDate: new Date(d), occupancy: opts.occupancy ?? 2, amountMinor: opts.amount ?? 50000n, amountBasis: opts.basis ?? ('SELL' as const), currency: 'AED' })) })
    if (opts.guestPrices?.length) await prisma.ratePlanGuestPrice.createMany({ data: opts.guestPrices.map((g) => ({ tenantId, ratePlanId: id, kind: g.kind, minAge: g.minAge, maxAge: g.maxAge, amountMinor: g.amountMinor, amountBasis: g.basis, currency: 'AED' })) })
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

  it('SR-12 the plan sale window removes the offer outside it and keeps it inside (ADR 0057)', async () => {
    const inside = await newPlan('in', { validFrom: checkIn, validTo: checkOut })
    const late = await newPlan('late-start', { validFrom: mid })
    const early = await newPlan('early-end', { validTo: mid })
    const list = await rates()
    expect(forPlan(list, inside)).toBeDefined()
    expect(forPlan(list, late)).toBeUndefined()
    expect(forPlan(list, early)).toBeUndefined()
  })

  it('SR-13 the offer carries the recorded payment type and never invents prepaid (ADR 0057)', async () => {
    const prepaid = await newPlan('pp', { paymentType: 'PREPAID' })
    const hotelPay = await newPlan('ph', { paymentType: 'PAY_AT_HOTEL' })
    const none = await newPlan('np')
    const list = await rates()
    expect(forPlan(list, prepaid)?.paymentType).toBe('prepaid')
    expect(forPlan(list, hotelPay)?.paymentType).toBe('pay_at_hotel')
    expect(forPlan(list, none)?.paymentType).toBe('unspecified')
  })

  it('SR-14 a plan names its own cancellation set; no set uses the contract default; a named set with no rules is not sellable (ADR 0057)', async () => {
    const rule = (policySet: string | null, daysBeforeCheckin: number) => prisma.cancellationPolicy.create({ data: { contractId, policySet, daysBeforeCheckin, penaltyPercent: 100 } })
    await rule(null, 3); await rule('STRICT', 14)
    try {
      const plain = await newPlan('plain')
      const strict = await newPlan('strict', { cancellationPolicySet: 'STRICT' })
      const gone = await newPlan('gone', { cancellationPolicySet: 'NOT-DEFINED' })
      const list = await rates()
      const d = (planId: string) => forPlan(list, planId)?.cancellation.deadline
      expect(d(plain)).toBeDefined(); expect(d(strict)).toBeDefined()
      expect(Date.parse(d(strict)!)).toBeLessThan(Date.parse(d(plain)!)) // 14 days before is earlier than 3 days before
      expect(Date.parse(d(plain)!) - Date.parse(d(strict)!)).toBe(11 * 86_400_000)
      expect(forPlan(list, gone)).toBeUndefined() // never silently falls back to the default
    } finally { await prisma.cancellationPolicy.deleteMany({ where: { contractId } }) }
  })

  it('SR-15 a plan nationality list narrows the contract and applies to the searching guest (ADR 0057, S3)', async () => {
    const open = await newPlan('open')
    const accepts = await newPlan('accepts-ae', { nationalities: ['AE', 'IN'] })
    const refuses = await newPlan('refuses-ae', { nationalities: ['IN'] })
    const list = await rates() // the guest nationality is AE
    expect(forPlan(list, open)).toBeDefined()
    expect(forPlan(list, accepts)).toBeDefined()
    expect(forPlan(list, refuses)).toBeUndefined()
    expect(forPlan(await rates(criteria({ nationality: 'IN' })), refuses)).toBeDefined()
  })

  it('SR-16 a plan sales-market list needs a known buyer market; a malformed list refuses everyone (ADR 0057, S3)', async () => {
    const restricted = await newPlan('mkt', { salesMarkets: ['AE'] })
    expect(forPlan(await rates(), restricted)).toBeUndefined() // no agency, so no known market: never satisfies a restriction
    const broken = await newPlan('broken')
    await expect(prisma.$executeRawUnsafe(`UPDATE "RatePlan" SET sales_markets = '"junk"'::jsonb WHERE id = '${broken}'`)).rejects.toThrow(/RatePlan_sales_markets_array_chk/) // the database refuses a non-array
    await prisma.$executeRawUnsafe(`UPDATE "RatePlan" SET sales_markets = '["ARE"]'::jsonb WHERE id = '${broken}'`) // an array with a bad code passes the CHECK; the evaluator fails closed
    expect(forPlan(await rates(), broken)).toBeUndefined()
  })

  it('SR-17 child and extra-adult lines: a family is priced per night by age band, flat plans are untouched, and recheck agrees (ADR 0057, S6)', async () => {
    await prisma.roomType.update({ where: { id: roomId }, data: { maxAdults: 3, maxChildren: 2, maxOccupancy: 4 } })
    try {
      const lines = [{ kind: 'CHILD' as const, minAge: 0, maxAge: 2, amountMinor: 0n, basis: 'SELL' as const }, { kind: 'CHILD' as const, minAge: 3, maxAge: 11, amountMinor: 10_000n, basis: 'SELL' as const }, { kind: 'EXTRA_ADULT' as const, minAge: 18, maxAge: 99, amountMinor: 20_000n, basis: 'SELL' as const }]
      const withLines = await newPlan('lines', { guestPrices: lines, amount: 50_000n })
      const flat3 = await newPlan('flat3', { occupancy: 3, amount: 70_000n })
      const nightsCount = BigInt(nights.length)
      // 2 adults + 1 child aged 8: base 500.00 + child 100.00 per night.
      const one = await rates(criteria({ adults: 2, children: 1, childAges: [8] }))
      expect(forPlan(one, withLines)).toMatchObject({ sellAmountMinor: Number(nightsCount * 60_000n), occupancy: { adults: 2, children: 1, childAges: [8] } })
      expect(forPlan(one, flat3)).toMatchObject({ sellAmountMinor: Number(nightsCount * 70_000n) }) // the original rule: 3 guests = occupancy 3, flat
      // a free infant and a paid child
      expect(forPlan(await rates(criteria({ adults: 2, children: 2, childAges: [1, 8] })), withLines)).toMatchObject({ sellAmountMinor: Number(nightsCount * 60_000n) })
      // 3 adults: one extra adult at 200.00
      expect(forPlan(await rates(criteria({ adults: 3 })), withLines)).toMatchObject({ sellAmountMinor: Number(nightsCount * 70_000n) })
      // exactly the base party: just the base rate; and the lines plan does not appear for the flat 3 rule
      expect(forPlan(await rates(), withLines)).toMatchObject({ sellAmountMinor: Number(nightsCount * 50_000n) })
      // a child the bands do not cover is not sold, never priced as free
      await prisma.ratePlanGuestPrice.deleteMany({ where: { ratePlanId: withLines, minAge: 3 } })
      expect(forPlan(await rates(criteria({ adults: 2, children: 1, childAges: [8] })), withLines)).toBeUndefined()
      expect(forPlan(await rates(criteria({ adults: 2, children: 1, childAges: [1] })), withLines)).toBeDefined()
      // recheck reproduces the same price from the stored child ages
      const offer = forPlan(await rates(criteria({ adults: 2, children: 1, childAges: [1] })), withLines)!
      expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })).toMatchObject({ status: 'available', offer: { sellAmountMinor: offer.sellAmountMinor } })
    } finally { await prisma.roomType.update({ where: { id: roomId }, data: { maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } }) }
  })

  it('SR-19 a promotion prices the stay on the net before the markup, only one applies, and recheck agrees (ADR 0058, S10a)', async () => {
    const promo = (planId: string, over: Record<string, unknown>) => prisma.ratePlanPromotion.create({ data: { tenantId, ratePlanId: planId, kind: 'EARLY_BIRD', name: 'P', nameKey: String(over.name ?? 'P').toLowerCase(), percentBp: 1000, minLeadDays: 14, ...over } })
    const sell = await newPlan('promo-sell', { amount: 50_000n })
    const unaffected = await newPlan('promo-none', { amount: 50_000n })
    // check-in is 20 days out in the hotel's calendar: a 14-day early bird applies, a 30-day one does not
    await promo(sell, { name: 'Early' })
    await promo(sell, { name: 'Too early', percentBp: 5000, minLeadDays: 30 })
    const first = await rates()
    expect(forPlan(first, sell)).toMatchObject({ sellAmountMinor: nights.length * 45_000 })
    expect(forPlan(first, unaffected)).toMatchObject({ sellAmountMinor: nights.length * 50_000 })
    // the larger saving wins and nothing stacks: one free night (50,000) beats 10% (10,000)
    await promo(sell, { name: 'Stay 2 pay 1', kind: 'FREE_NIGHTS', percentBp: null, minLeadDays: null, minNights: 2, freeNights: 1 })
    const offer = forPlan(await rates(), sell)!
    expect(offer.sellAmountMinor).toBe(50_000)
    expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { ...ctx, userId })).toMatchObject({ status: 'available', offer: { sellAmountMinor: 50_000 } })
    // a NET plan: the markup follows the discounted net. 10,001 less 20% (2,000.7 -> 2,000) = 8,001; markup 10% = 800.1 -> 800; sell 8,801 per night
    await prisma.commercialMarkupRule.create({ data: { tenantId, scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: new Date('2026-01-01'), status: 'ACTIVE', activatedAt: new Date(), reason: 'test', createdById: userId } })
    try {
      const net = await newPlan('promo-net', { amount: 10_001n, basis: 'NET' })
      await promo(net, { name: 'Twenty', percentBp: 2000 })
      expect(forPlan(await rates(), net)).toMatchObject({ netAmountMinor: nights.length * 8_001, markupAmountMinor: nights.length * 800, sellAmountMinor: nights.length * 8_801 })
    } finally { await prisma.commercialMarkupRule.deleteMany({ where: { tenantId } }) }
  })

  it('SR-18 a NET plan applies the markup to the base plus the child lines, per night (ADR 0057, S6)', async () => {
    await prisma.roomType.update({ where: { id: roomId }, data: { maxAdults: 2, maxChildren: 1, maxOccupancy: 3 } })
    await prisma.commercialMarkupRule.create({ data: { tenantId, scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: new Date('2026-01-01'), status: 'ACTIVE', activatedAt: new Date(), reason: 'test', createdById: userId } })
    try {
      const plan = await newPlan('net', { amount: 10_001n, basis: 'NET', guestPrices: [{ kind: 'CHILD', minAge: 3, maxAge: 11, amountMinor: 5_005n, basis: 'NET' }] })
      const offer = forPlan(await rates(criteria({ adults: 2, children: 1, childAges: [5] })), plan)!
      // per night: net 15,006; markup 10% = 1,500.6 -> 1,501 half up; sell 16,507
      expect(offer).toMatchObject({ netAmountMinor: nights.length * 15_006, markupAmountMinor: nights.length * 1_501, sellAmountMinor: nights.length * 16_507 })
      await prisma.ratePlanGuestPrice.updateMany({ where: { ratePlanId: plan }, data: { amountBasis: 'SELL' } })
      expect(forPlan(await rates(criteria({ adults: 2, children: 1, childAges: [5] })), plan)).toBeUndefined() // basis mismatch fails closed
    } finally {
      await prisma.commercialMarkupRule.deleteMany({ where: { tenantId } })
      await prisma.roomType.update({ where: { id: roomId }, data: { maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    }
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
