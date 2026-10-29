import type { SearchCriteria } from '@bedbanks/domain'
import { ContractedInventoryAdapter } from './contracted-inventory.adapter'
import type { PrismaService } from '../database/prisma.service'

/**
 * Deterministic certification of the contracted-inventory search and authoritative recheck at 1 and 100 hotels.
 *
 * The REAL adapter, loaders, snapshot builder and evaluator run; only PostgreSQL is replaced by an in-memory tenant-scoped store that serves the same
 * relation shapes the adapter reads. SQL pre-filters (contract status/validity, occupancy, mapping joins) are therefore NOT proven here: the evaluator
 * re-applies them and the PostgreSQL suites (`dubai-agent-search*.e2e-spec.ts`, `inventory-search-recheck.e2e-spec.ts`) prove the database side.
 * Time is frozen, ids are derived from the hotel index, and money is integer minor units (AED, 2 decimals).
 */

const NOW = new Date('2026-10-05T08:00:00.000Z')
const TENANT = 'tenant-a'
const OTHER_TENANT = 'tenant-b'
const NIGHTS = ['2026-10-15', '2026-10-16', '2026-10-17']
const at = (day: string) => new Date(`${day}T00:00:00.000Z`)
const criteria = (patch: Partial<SearchCriteria> = {}): SearchCriteria => ({
  destination: 'Dubai', checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', ...patch,
})
const context = { tenantId: TENANT, userId: 'user-a', requestId: 'req-a' }

interface Rate { stayDate: Date; occupancy: number; amountMinor: bigint; currency: string; amountBasis: string | null }
interface Row { stayDate: Date; allotment: number; sold: number; held: number; stopSell: boolean; minStay: number; closedToArrival: boolean; releaseDays: number | null; closedToDeparture: boolean; inventoryMode: string; source: string; freshUntil: Date | null }

const availabilityRow = (day: string, patch: Partial<Row> = {}): Row => ({ stayDate: at(day), allotment: 5, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false, releaseDays: null, closedToDeparture: false, inventoryMode: 'ALLOTMENT', source: 'ADMIN', freshUntil: null, ...patch })

interface Fixture { plan: Record<string, any>; hotel: Record<string, any> }

/** One hotel, one room, one board, one active mapped contract and one plan. `base` is the nightly minor-unit rate of hotel index `i`. */
function fixture(i: number, patch: { basis?: 'NET' | 'SELL'; base?: number; tenantId?: string } = {}): Fixture {
  const id = String(i).padStart(3, '0')
  const tenantId = patch.tenantId ?? TENANT
  const hotel = {
    id: `hotel-${id}`, tenantId, name: `Dubai Hotel ${id}`, city: 'Dubai', starRating: 3 + (i % 3), propertyType: 'HOTEL', address: `${i} Sheikh Zayed Road`,
    latitude: null, longitude: null, timeZone: 'Asia/Dubai', contentStatus: 'COMPLETE', profile: { localCharges: null, brandName: null },
  }
  const base = patch.base ?? 30_000 + i * 100
  const plan = {
    id: `plan-${id}`, tenantId, status: 'ACTIVE', code: `BAR-${id}`, refundable: true, paymentType: 'CREDIT', taxesIncluded: true, feesIncluded: true,
    currency: 'AED', occupancy: 2, minStay: 1, maxStay: null, releaseDays: 0, releaseTimeLocal: '00:00', validFrom: null, validTo: null, cancellationPolicySet: null,
    salesMarkets: [], nationalities: [], inventoryPoolId: null, inventoryPool: null,
    boardBasisId: 'bb-bed', boardBasis: { id: 'bb-bed', tenantId, name: 'Bed and breakfast', isActive: true },
    roomTypeId: `room-${id}`,
    roomType: { id: `room-${id}`, name: 'Deluxe King', isActive: true, maxAdults: 3, maxChildren: 2, maxOccupancy: 4, hotelId: hotel.id, hotel },
    contractId: `contract-${id}`,
    contract: {
      id: `contract-${id}`, tenantId, status: 'ACTIVE', supplierId: `supplier-${id}`, supplier: { id: `supplier-${id}`, status: 'ACTIVE', type: 'HOTEL_DIRECT' },
      validFrom: at('2026-01-01'), validTo: at('2026-12-31'), settlementCurrency: 'AED', minStayMode: 'STAY_THROUGH', clientBufferDays: 0,
      salesMarkets: [], nationalities: [], cancellationPolicies: [], leadTimeRules: [], supplements: [], eventSupplements: [], childPolicies: [],
      supplierHotelMapping: { status: 'MAPPED', tenantId, hotelId: hotel.id, supplierHotelId: `sup-hotel-${id}`, roomMappings: [{ tenantId, roomTypeId: `room-${id}`, status: 'MAPPED', supplierRoomId: `sup-room-${id}` }] },
    },
    dailyRates: NIGHTS.map((day): Rate => ({ stayDate: at(day), occupancy: 2, amountMinor: BigInt(base), currency: 'AED', amountBasis: patch.basis ?? 'SELL' })),
    guestPrices: [], promotions: [], derivedFromId: null, derivedMode: null, derivedAdjustment: null, derivedFrom: null,
    availability: [...NIGHTS, '2026-10-18'].map((day) => availabilityRow(day)),
  }
  return { plan, hotel }
}

/** In-memory tenant-scoped store behind `PrismaService.withTenant`. Mutating `fixtures`/`markupRules` between calls models an Admin edit. */
class Store {
  fixtures: Fixture[] = []
  markupRules: Array<Record<string, unknown>> = []
  deals: Array<{ ratePlanId: string; deal: Record<string, unknown> }> = []
  ratePlanReads: string[][] = []
  readonly tenantsSeen = new Set<string>()

  prisma(): PrismaService {
    const store = this
    const tx = {
      supplier: { count: async () => 1 },
      hotel: {
        findMany: async ({ where }: any) => store.fixtures.filter((f) => f.hotel.tenantId === where.tenantId && f.hotel.contentStatus === 'COMPLETE' &&
          (!where.id || where.id.in.includes(f.hotel.id)) && (!where.city || f.hotel.city.toLowerCase().includes(where.city.contains.toLowerCase())))
          .map((f) => ({ id: f.hotel.id })).sort((a, b) => a.id.localeCompare(b.id)),
      },
      ratePlan: {
        findMany: async ({ where }: any) => {
          const hotelIds: string[] = where.roomType.hotelId.in
          store.ratePlanReads.push(hotelIds)
          return store.fixtures.filter((f) => f.plan.tenantId === where.tenantId && hotelIds.includes(f.hotel.id)).map((f) => f.plan).sort((a, b) => a.id.localeCompare(b.id))
        },
      },
      hotelDealRatePlan: { findMany: async ({ where }: any) => store.deals.filter((d) => where.ratePlanId.in.includes(d.ratePlanId)) },
      fxRate: { findMany: async () => [] },
      commercialMarkupRule: { findMany: async () => store.markupRules },
      agency: { findFirst: async () => ({ id: 'agency-a', countryCode: 'AE' }) },
      distributionRestriction: { findMany: async () => [] },
      hotelImage: { findMany: async () => [] },
    }
    return { withTenant: async (tenantId: string, work: (t: unknown) => unknown) => { store.tenantsSeen.add(tenantId); return work(tx) } } as unknown as PrismaService
  }
}

const HOTEL_MARKUP = (hotelId: string, basisPoints: number) => ({ scope: 'HOTEL', supplierId: null, hotelId, basisPoints, validFrom: at('2026-01-01'), validTo: null, agencyId: null, market: null, excludedHotelIds: [], excludedSupplierIds: [] })
const TENANT_MARKUP = (basisPoints: number) => ({ scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints, validFrom: at('2026-01-01'), validTo: null, agencyId: null, market: null, excludedHotelIds: [], excludedSupplierIds: [] })
const LONG_STAY_10 = { id: 'promo-long', kind: 'LONG_STAY', name: 'Stay 3 save 10%', percentBp: 1000, minLeadDays: null, maxLeadDays: null, minNights: 3, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, combinable: false, stayWindowMode: 'ARRIVAL', discountBase: 'NET' }
const GALA = { kind: 'COMPULSORY', name: 'Gala dinner', boardBasisId: null, ratePlanId: null, basis: 'PER_ROOM', frequency: 'PER_NIGHT', amountMinor: 5_000n, currency: 'AED', stayFrom: null, stayTo: null }

function setup(count: number, tweak: (fixtures: Fixture[]) => void = () => undefined) {
  const store = new Store()
  store.fixtures = Array.from({ length: count }, (_, i) => fixture(i + 1))
  tweak(store.fixtures)
  const adapter = new ContractedInventoryAdapter(store.prisma())
  return { store, adapter }
}

const flat = (offers: Awaited<ReturnType<ContractedInventoryAdapter['search']>>['offers']) => offers.flatMap((hotel) => hotel.rooms.flatMap((room) => room.rates.map((rate) => ({ hotel, room, rate }))))

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }).setSystemTime(NOW) })
afterEach(() => { jest.useRealTimers() })

describe.each([1, 100])('contracted inventory search and recheck over %i hotel(s)', (count) => {
  it('returns every sellable hotel once, in a stable order, with exact integer minor-unit totals', async () => {
    const { adapter } = setup(count)
    const first = await adapter.search(criteria(), context)
    expect(first.providerSummary).toEqual({ queried: 1, succeeded: 1, failed: 0 })
    const rows = flat(first.offers)
    expect(first.offers).toHaveLength(count)
    expect(new Set(first.offers.map((hotel) => hotel.hotelId)).size).toBe(count)
    expect(first.offers.map((hotel) => hotel.name)).toEqual([...first.offers.map((hotel) => hotel.name)].sort((a, b) => a.localeCompare(b)))
    expect(new Set(rows.map(({ rate }) => rate.offerId)).size).toBe(count)
    rows.forEach(({ hotel, rate }) => {
      const i = Number(hotel.hotelId.slice(-3))
      expect(rate.offerId.startsWith('ci_')).toBe(true)
      expect(Number.isSafeInteger(rate.sellAmountMinor)).toBe(true)
      expect(rate.sellAmountMinor).toBe((30_000 + i * 100) * 3)
      expect(rate).toMatchObject({ tenantId: TENANT, canonicalHotelId: hotel.hotelId, total: { amountMinor: rate.sellAmountMinor, currency: 'AED' }, markupAmountMinor: 0, availability: 'available', available: true })
      expect(Date.parse(rate.expiresAt)).toBe(NOW.getTime() + 900_000)
    })
    // Same commercial result on a repeat search (offer ids differ by design).
    const second = await adapter.search(criteria(), context)
    const strip = (offers: typeof first.offers) => flat(offers).map(({ hotel, room, rate }) => [hotel.hotelId, room.roomTypeId, rate.ratePlanId, rate.sellAmountMinor])
    expect(strip(second.offers)).toEqual(strip(first.offers))
    expect(flat(second.offers).some(({ rate }) => first.offers.some((h) => h.rooms.some((r) => r.rates.some((x) => x.offerId === rate.offerId))))).toBe(false)
  })

  it('reads plans in bounded batches rather than one query per hotel', async () => {
    const { adapter, store } = setup(count)
    await adapter.search(criteria(), context)
    expect(store.ratePlanReads.flat().sort()).toEqual(store.fixtures.map((f) => f.hotel.id).sort())
    expect(store.ratePlanReads.length).toBeLessThanOrEqual(Math.ceil(count / 100))
  })

  it('occupancy: unsupported parties are removed, supported ones priced; nothing is copied or dropped to make a party fit', async () => {
    const { adapter } = setup(count)
    expect((await adapter.search(criteria({ adults: 3 }), context)).offers).toEqual([]) // plan is a double, no extra-adult line
    expect((await adapter.search(criteria({ adults: 5 }), context)).offers).toEqual([]) // beyond the room
    expect((await adapter.search(criteria({ adults: 1 }), context)).offers).toEqual([]) // single party never sells a double rate
    expect((await adapter.search(criteria({ adults: 2, children: 1, childAges: [6] }), context)).offers).toEqual([]) // no child price: never free
    expect((await adapter.search(criteria({ rooms: 6 }), context)).offers).toEqual([]) // stock is 5 per night
    const two = await adapter.search(criteria({ rooms: 2 }), context)
    expect(flat(two.offers)[0]!.rate.sellAmountMinor).toBe(2 * (30_000 + 100) * 3)
  })

  it('occupancy: child lines price a family per night by age, and a missing age is refused', async () => {
    const { adapter } = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.guestPrices = [{ kind: 'CHILD', minAge: 0, maxAge: 11, amountMinor: 10_000n, amountBasis: 'SELL', currency: 'AED' }, { kind: 'EXTRA_ADULT', minAge: 18, maxAge: 99, amountMinor: 20_000n, amountBasis: 'SELL', currency: 'AED' }] }))
    const family = await adapter.search(criteria({ adults: 2, children: 1, childAges: [6] }), context)
    expect(family.offers).toHaveLength(count)
    expect(flat(family.offers)[0]!.rate.sellAmountMinor).toBe((30_100 + 10_000) * 3)
    expect(flat(family.offers)[0]!.rate.occupancy).toEqual({ rooms: 1, adults: 2, children: 1, childAges: [6] })
    const triple = await adapter.search(criteria({ adults: 3 }), context)
    expect(flat(triple.offers)[0]!.rate.sellAmountMinor).toBe((30_100 + 20_000) * 3)
    expect((await adapter.search(criteria({ adults: 2, children: 1, childAges: [14] }), context)).offers).toEqual([]) // age 14 has no band
  })

  it('nationality: an allow-list sells only to a listed guest; a blank or malformed nationality never satisfies it', async () => {
    const { adapter } = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.nationalities = ['IN', 'AE'] }))
    expect((await adapter.search(criteria({ nationality: 'IN' }), context)).offers).toHaveLength(count)
    expect((await adapter.search(criteria({ nationality: 'in' }), context)).offers).toHaveLength(count)
    for (const nationality of ['GB', '', 'India', ' ']) expect((await adapter.search(criteria({ nationality }), context)).offers).toEqual([])
    // A contract-level list narrows independently of the plan.
    const contract = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.contract.nationalities = ['AE'] }))
    expect((await contract.adapter.search(criteria({ nationality: 'IN' }), context)).offers).toEqual([])
    expect((await contract.adapter.search(criteria({ nationality: 'AE' }), context)).offers).toHaveLength(count)
  })

  it('daily rates: one missing, zero or foreign-currency night removes only that hotel; others keep their own price', async () => {
    const { adapter } = setup(count, (fixtures) => {
      if (fixtures.length < 3) return
      fixtures[0]!.plan.dailyRates.splice(1, 1) // missing night
      fixtures[1]!.plan.dailyRates[2].amountMinor = 0n // zero rate
      fixtures[2]!.plan.dailyRates[0].currency = 'USD' // foreign currency
    })
    const result = await adapter.search(criteria(), context)
    const removed = count >= 3 ? 3 : 0
    expect(result.offers).toHaveLength(count - removed)
    if (count >= 3) expect(result.offers.map((h) => h.hotelId)).not.toEqual(expect.arrayContaining(['hotel-001']))
    flat(result.offers).forEach(({ hotel, rate }) => expect(rate.sellAmountMinor).toBe((30_000 + Number(hotel.hotelId.slice(-3)) * 100) * 3))
  })

  it('NET rates are marked up per night in integer minor units; without a rule they are not sold at all', async () => {
    const { adapter, store } = setup(count, (fixtures) => fixtures.forEach((f) => f.plan.dailyRates.forEach((rate: Rate) => { rate.amountBasis = 'NET' })))
    expect((await adapter.search(criteria(), context)).offers).toEqual([]) // no ACTIVE rule: unsellable, never at zero markup
    store.markupRules = [TENANT_MARKUP(800), HOTEL_MARKUP('hotel-001', 1500)]
    const result = await adapter.search(criteria(), context)
    expect(result.offers).toHaveLength(count)
    flat(result.offers).forEach(({ hotel, rate }) => {
      const net = (30_000 + Number(hotel.hotelId.slice(-3)) * 100) * 3
      const nightlyNet = 30_000 + Number(hotel.hotelId.slice(-3)) * 100
      const bp = hotel.hotelId === 'hotel-001' ? 1500 : 800
      const markup = 3 * Math.floor((nightlyNet * bp + 5_000) / 10_000)
      expect(rate).toMatchObject({ netAmountMinor: net, markupAmountMinor: markup, sellAmountMinor: net + markup, totalAmountMinor: net })
      expect(rate.sellAmountMinor).toBe(rate.netAmountMinor! + rate.markupAmountMinor)
    })
  })

  it('promotions and supplements: discount the net, add supplements after it, mark up the sum, and name both on the offer', async () => {
    const { adapter, store } = setup(count, (fixtures) => fixtures.forEach((f) => {
      f.plan.dailyRates.forEach((rate: Rate) => { rate.amountBasis = 'NET'; rate.amountMinor = 30_000n })
      f.plan.promotions = [LONG_STAY_10]
      f.plan.contract.supplements = [GALA]
    }))
    store.markupRules = [TENANT_MARKUP(1500)]
    const result = await adapter.search(criteria(), context)
    expect(result.offers).toHaveLength(count)
    flat(result.offers).forEach(({ rate }) => {
      // 30,000 -10% = 27,000; + 5,000 gala = 32,000; + 15% = 36,800 per night.
      expect(rate).toMatchObject({ netAmountMinor: 96_000, markupAmountMinor: 14_400, sellAmountMinor: 110_400 })
      expect(rate.promotion).toEqual({ name: 'Stay 3 save 10%', kind: 'LONG_STAY' })
      expect(rate.supplements).toEqual([{ name: 'Gala dinner', kind: 'COMPULSORY', amountMinor: 15_000 }])
    })
  })

  it('expired commercial terms remove the offer: contract, plan window, promotion booking window, lead time and release', async () => {
    const expiredContract = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.contract.validTo = at('2026-10-16') }))
    expect((await expiredContract.adapter.search(criteria(), context)).offers).toEqual([]) // last night 17 Oct is outside
    const inclusive = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.contract.validTo = at('2026-10-17') }))
    expect((await inclusive.adapter.search(criteria(), context)).offers).toHaveLength(count) // validTo is the last stay night, inclusive
    const expiredPlan = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.validTo = at('2026-10-16') }))
    expect((await expiredPlan.adapter.search(criteria(), context)).offers).toEqual([])
    const release = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.releaseDays = 11 })) // check-in is 10 days out
    expect((await release.adapter.search(criteria(), context)).offers).toEqual([])
    const lead = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.contract.leadTimeRules = [{ minLeadHours: 24 * 11, maxLeadDays: null }] }))
    expect((await lead.adapter.search(criteria(), context)).offers).toEqual([])
    // A promotion whose booking window already closed is simply not applied: the stay sells at the contracted rate, never discounted.
    const closed = setup(count, (fixtures) => fixtures.forEach((f) => { f.plan.promotions = [{ ...LONG_STAY_10, bookTo: at('2026-10-01') }] }))
    const rows = flat((await closed.adapter.search(criteria(), context)).offers)
    expect(rows).toHaveLength(count)
    rows.forEach(({ rate }) => expect(rate.promotion).toBeUndefined())
  })

  it('stock gates remove only the affected hotels: stop-sell, sold out, closed to arrival, closed mode, stale feed', async () => {
    const { adapter } = setup(count, (fixtures) => {
      if (fixtures.length < 5) return
      fixtures[0]!.plan.availability[1].stopSell = true
      fixtures[1]!.plan.availability[0].sold = 5
      fixtures[2]!.plan.availability[0].closedToArrival = true
      fixtures[3]!.plan.availability[2].inventoryMode = 'CLOSED'
      fixtures[4]!.plan.availability[0] = availabilityRow('2026-10-15', { source: 'SUPPLIER_SYNC', freshUntil: new Date('2026-10-01T00:00:00.000Z') })
    })
    const result = await adapter.search(criteria(), context)
    expect(result.offers).toHaveLength(count >= 5 ? count - 5 : count)
    if (count >= 5) expect(result.offers.map((h) => h.hotelId)).not.toEqual(expect.arrayContaining(['hotel-001', 'hotel-002', 'hotel-003', 'hotel-004', 'hotel-005']))
  })

  it('tenant isolation: another tenant sees none of these hotels and the adapter only ever reads as the caller tenant', async () => {
    const { adapter, store } = setup(count)
    const foreign = await adapter.search(criteria(), { ...context, tenantId: OTHER_TENANT })
    expect(foreign.offers).toEqual([])
    expect([...store.tenantsSeen]).toEqual([OTHER_TENANT])
  })

  it('recheck reprices from the current Admin state: unchanged, higher, lower, stop-sold, unmapped and expired', async () => {
    const { adapter, store } = setup(count)
    const rows = flat((await adapter.search(criteria(), context)).offers)
    const pick = [rows[0]!, rows[Math.floor(rows.length / 2)]!, rows[rows.length - 1]!]
    for (const { rate } of pick) {
      const result = await adapter.recheck({ offerId: rate.offerId, searchId: 'search-a' } as never, context)
      expect(result).toMatchObject({ status: 'available', offer: { offerId: rate.offerId, sellAmountMinor: rate.sellAmountMinor, currency: 'AED', rooms: 1, adults: 2, canonicalHotelId: rate.canonicalHotelId, expiresAt: rate.expiresAt } })
    }
    const [first, middle, last] = pick
    const firstFixture = store.fixtures.find((f) => f.hotel.id === first!.hotel.hotelId)!
    firstFixture.plan.dailyRates[0].amountMinor += 500n // price rises by 5.00 AED
    const higher = await adapter.recheck({ offerId: first!.rate.offerId, searchId: 'search-a' } as never, context)
    expect(higher).toMatchObject({ status: 'available', offer: { sellAmountMinor: first!.rate.sellAmountMinor + 500 } }) // the caller compares with the quoted amount
    store.fixtures.find((f) => f.hotel.id === middle!.hotel.hotelId)!.plan.availability[1]!.stopSell = true
    expect(await adapter.recheck({ offerId: middle!.rate.offerId, searchId: 'search-a' } as never, context)).toEqual({ status: 'unavailable' })
    store.fixtures.find((f) => f.hotel.id === last!.hotel.hotelId)!.plan.contract.supplierHotelMapping.status = 'REVOKED'
    expect(await adapter.recheck({ offerId: last!.rate.offerId, searchId: 'search-a' } as never, context)).toEqual({ status: 'unavailable' })
    // Elapsed offers are expired, not repriced.
    jest.setSystemTime(new Date(NOW.getTime() + 900_001))
    expect(await adapter.recheck({ offerId: first!.rate.offerId, searchId: 'search-a' } as never, context)).toEqual({ status: 'offer_expired' })
  })

  it('recheck never trusts another tenant, an unknown offer or a changed rate plan; sold-out stock is unavailable', async () => {
    const { adapter, store } = setup(count)
    const [{ rate }] = flat((await adapter.search(criteria(), context)).offers)
    expect(await adapter.recheck({ offerId: rate.offerId, searchId: 's' } as never, { ...context, tenantId: OTHER_TENANT })).toEqual({ status: 'unavailable' })
    expect(await adapter.recheck({ offerId: 'ci_unknown', searchId: 's' } as never, context)).toEqual({ status: 'unavailable' })
    store.fixtures[0]!.plan.availability[2].sold = 5
    expect(await adapter.recheck({ offerId: rate.offerId, searchId: 's' } as never, context)).toEqual({ status: 'unavailable' })
  })

  it('recheck re-applies the searched nationality and never allocates stock', async () => {
    const { adapter, store } = setup(count)
    const [{ rate }] = flat((await adapter.search(criteria({ nationality: 'IN' }), context)).offers)
    store.fixtures[0]!.plan.nationalities = ['AE'] // the hotel narrows the plan after the quote
    expect(await adapter.recheck({ offerId: rate.offerId, searchId: 's' } as never, context)).toEqual({ status: 'unavailable' })
    store.fixtures[0]!.plan.nationalities = ['IN']
    expect((await adapter.recheck({ offerId: rate.offerId, searchId: 's' } as never, context)).status).toBe('available')
    expect(store.fixtures[0]!.plan.availability.every((row: Row) => row.sold === 0 && row.held === 0)).toBe(true)
  })

  it('cancel and prebook stay closed: booking remains disabled', async () => {
    const { adapter } = setup(count)
    await expect(adapter.cancel()).rejects.toThrow('Booking is unavailable')
    await expect(adapter.prebook({ offerId: 'ci_none', searchId: 's', idempotencyKey: 'k' } as never, context)).rejects.toMatchObject({ code: 'malformed_response' })
  })
})

describe('contracted inventory search: batching, failures and offer memory', () => {
  it('walks 100 hotels in several batches without losing or duplicating any (AGENT_SEARCH_HOTEL_BATCH=7)', async () => {
    const previous = process.env.AGENT_SEARCH_HOTEL_BATCH
    process.env.AGENT_SEARCH_HOTEL_BATCH = '7'
    try {
      await jest.isolateModulesAsync(async () => {
        const { ContractedInventoryAdapter: Batched } = await import('./contracted-inventory.adapter')
        const store = new Store()
        store.fixtures = Array.from({ length: 100 }, (_, i) => fixture(i + 1))
        const result = await new Batched(store.prisma()).search(criteria(), context)
        expect(store.ratePlanReads).toHaveLength(Math.ceil(100 / 7))
        expect(store.ratePlanReads.flat()).toHaveLength(100)
        expect(new Set(result.offers.map((h) => h.hotelId)).size).toBe(100)
      })
    } finally {
      if (previous === undefined) delete process.env.AGENT_SEARCH_HOTEL_BATCH
      else process.env.AGENT_SEARCH_HOTEL_BATCH = previous
    }
  })

  it('a failed commercial read is a provider error, never an empty or zero-priced success', async () => {
    const { adapter, store } = setup(3, (fixtures) => fixtures.forEach((f) => f.plan.dailyRates.forEach((rate: Rate) => { rate.amountBasis = 'NET' })))
    store.markupRules = [{ ...TENANT_MARKUP(800), basisPoints: -1 }] // malformed rule
    await expect(adapter.search(criteria(), context)).rejects.toMatchObject({ code: 'commercial_control_unavailable' })
    const broken = setup(3)
    ;(broken.store as unknown as { prisma: () => PrismaService }).prisma = () => ({ withTenant: async () => { throw new Error('db down') } }) as unknown as PrismaService
    await expect(new ContractedInventoryAdapter(broken.store.prisma()).search(criteria(), context)).rejects.toMatchObject({ code: 'transport' })
  })

  it('a tenant with no supplier is unconfigured, not an empty result', async () => {
    const prisma = { withTenant: async (_tenantId: string, work: (tx: unknown) => unknown) => work({ supplier: { count: async () => 0 } }) } as unknown as PrismaService
    await expect(new ContractedInventoryAdapter(prisma).search(criteria(), context)).rejects.toMatchObject({ code: 'unconfigured' })
  })

  it('does not accumulate elapsed offers in process memory, yet still reports a just-elapsed offer as expired', async () => {
    const { adapter } = setup(2)
    const remembered = () => (adapter as unknown as { offers: Map<string, unknown> }).offers.size
    const [{ rate }] = flat((await adapter.search(criteria(), context)).offers)
    expect(remembered()).toBe(2)
    jest.setSystemTime(new Date(NOW.getTime() + 900_001))
    expect(await adapter.recheck({ offerId: rate.offerId, searchId: 's' } as never, context)).toEqual({ status: 'offer_expired' })
    jest.setSystemTime(new Date(NOW.getTime() + 900_000 + 3_600_001 + 120_000)) // well past the retention window
    await adapter.search(criteria(), context)
    expect(remembered()).toBe(2) // the two new offers only; the elapsed pair was swept
  })
})
