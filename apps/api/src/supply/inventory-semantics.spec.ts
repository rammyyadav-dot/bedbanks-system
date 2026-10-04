import { evaluateContractedStay, rowIsFresh, type ContractedStaySnapshot, type StayRequest } from './contracted-sellability'
import { buildStaySnapshot, nightStock, type StayPlanInput } from './stay-snapshot'

const NOW = new Date('2026-10-05T08:00:00.000Z')
const base: StayRequest = { checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 1, adults: 2, children: 0, currency: 'AED', now: NOW }
const at = (d: string) => new Date(`${d}T00:00:00.000Z`)
const DATES = ['2026-10-15', '2026-10-16', '2026-10-17']

type Row = StayPlanInput['availability'][number]
function row(date: string, patch: Partial<Row> = {}): Row {
  return { stayDate: at(date), allotment: 5, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false, closedToDeparture: false, inventoryMode: 'ALLOTMENT', source: 'ADMIN', freshUntil: null, ...patch }
}
function plan(o: { rows?: Row[]; pool?: StayPlanInput['inventoryPool']; poolId?: string | null; releaseDays?: number; releaseTime?: string } = {}): StayPlanInput {
  return {
    status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1, maxStay: null, releaseDays: o.releaseDays ?? 0, releaseTimeLocal: o.releaseTime ?? '00:00',
    inventoryPoolId: o.poolId ?? null, inventoryPool: o.pool ?? null,
    roomType: { hotelId: 'h1', isActive: true, maxAdults: 2, maxChildren: 0, maxOccupancy: 2, hotel: { contentStatus: 'COMPLETE', timeZone: 'Asia/Dubai' } },
    boardBasis: { isActive: true },
    contract: { status: 'ACTIVE', validFrom: at('2026-01-01'), validTo: at('2027-01-01'), settlementCurrency: 'AED', supplier: { status: 'ACTIVE' } },
    dailyRates: [...DATES, '2026-10-18'].map((d) => ({ stayDate: at(d), amountMinor: 30_000n, currency: 'AED', amountBasis: 'SELL' })),
    availability: o.rows ?? [...DATES, '2026-10-18'].map((d) => row(d)),
  }
}
const decide = (p: StayPlanInput, request: Partial<StayRequest> = {}) =>
  evaluateContractedStay(buildStaySnapshot(p, { status: 'MAPPED', hotelId: 'h1' }, { status: 'MAPPED' }, DATES), { ...base, ...request })
const day = (d: string, patch: Partial<Row>) => row(d, patch)
const rowsWith = (nightPatch: (d: string) => Partial<Row>, departure: Partial<Row> = {}) => [...DATES.map((d) => day(d, nightPatch(d))), day('2026-10-18', departure)]

describe('inventory modes', () => {
  it('ALLOTMENT sells while stock remains and reports the minimum remaining', () => {
    const d = decide(plan({ rows: rowsWith((x) => (x === '2026-10-16' ? { allotment: 3, sold: 1 } : {})) }))
    expect(d).toMatchObject({ eligible: true, availabilityStatus: 'available', minRemaining: 2 })
  })
  it('ALLOTMENT at zero is NO_INVENTORY, not available', () => {
    const d = decide(plan({ rows: rowsWith(() => ({ allotment: 2, sold: 1, held: 1 })) }))
    expect(d).toMatchObject({ eligible: false, availabilityStatus: 'unavailable' }); expect(d.reasons).toContain('NO_INVENTORY')
  })
  it('FREE_SALE needs no counters, even with allotment 0, and reports no remaining count', () => {
    const d = decide(plan({ rows: rowsWith(() => ({ inventoryMode: 'FREE_SALE', allotment: 0 })) }))
    expect(d).toMatchObject({ eligible: true, availabilityStatus: 'available', minRemaining: null })
  })
  it('FREE_SALE still honours stop sell', () => {
    expect(decide(plan({ rows: rowsWith(() => ({ inventoryMode: 'FREE_SALE', stopSell: true })) })).reasons).toContain('STOP_SELL')
  })
  it('ON_REQUEST is priced but never eligible and never confirmed', () => {
    const d = decide(plan({ rows: rowsWith(() => ({ inventoryMode: 'ON_REQUEST', allotment: 9 })) }))
    expect(d).toMatchObject({ eligible: false, availabilityStatus: 'on_request', totalMinor: 90_000n, reasons: ['ON_REQUEST_ONLY'] })
  })
  it('ON_REQUEST with another blocker is simply unavailable with no price', () => {
    const d = decide(plan({ rows: rowsWith((x) => (x === '2026-10-15' ? { inventoryMode: 'ON_REQUEST', stopSell: true } : {})) }))
    expect(d).toMatchObject({ eligible: false, availabilityStatus: 'unavailable', totalMinor: null })
  })
  it('a single CLOSED night closes the stay', () => {
    const d = decide(plan({ rows: rowsWith((x) => (x === '2026-10-16' ? { inventoryMode: 'CLOSED' } : {})) }))
    expect(d.eligible).toBe(false); expect(d.reasons).toContain('INVENTORY_CLOSED')
  })
  it('an unknown mode value fails closed', () => {
    expect(decide(plan({ rows: rowsWith(() => ({ inventoryMode: 'WHATEVER' })) })).reasons).toContain('INVENTORY_CLOSED')
  })
  it('a missing row is AVAILABILITY_MISSING, never zero stock', () => {
    const d = decide(plan({ rows: [day('2026-10-15', {}), day('2026-10-17', {})] }))
    expect(d.reasons).toContain('AVAILABILITY_MISSING'); expect(d.reasons).not.toContain('NO_INVENTORY')
  })
})

describe('shared allotment pool', () => {
  const poolDays = (capacity: number, sold = 0, held = 0) => DATES.map((d) => ({ stayDate: at(d), capacity, sold, held, source: 'ADMIN', freshUntil: null }))
  it('3 plans over 5 rooms is 5 units, not 15: each plan row ignores its own allotment', () => {
    const rows = rowsWith(() => ({ allotment: 5 }))
    const pool = { days: poolDays(5, 3, 1) }
    // Three plans, each with allotment 5 on the row, all draw on the same pool day: 5-3-1 = 1 remaining
    for (let i = 0; i < 3; i += 1) {
      const d = decide(plan({ rows, poolId: 'pool-1', pool }), { rooms: 1 })
      expect(d).toMatchObject({ eligible: true, minRemaining: 1 })
      expect(decide(plan({ rows, poolId: 'pool-1', pool }), { rooms: 2 }).reasons).toContain('POOL_EXHAUSTED')
    }
  })
  it('an exhausted pool blocks even though the plan row has stock', () => {
    const d = decide(plan({ rows: rowsWith(() => ({ allotment: 50 })), poolId: 'p', pool: { days: poolDays(5, 5) } }))
    expect(d.reasons).toContain('POOL_EXHAUSTED'); expect(d.reasons).not.toContain('NO_INVENTORY')
  })
  it('a missing pool day is AVAILABILITY_MISSING, not zero', () => {
    const d = decide(plan({ poolId: 'p', pool: { days: poolDays(5).slice(0, 2) } }))
    expect(d.reasons).toContain('AVAILABILITY_MISSING'); expect(d.reasons).not.toContain('POOL_EXHAUSTED')
  })
  it('a stale pool day fails closed', () => {
    const stale = poolDays(5).map((x) => ({ ...x, freshUntil: new Date(NOW.getTime() - 1) }))
    expect(decide(plan({ poolId: 'p', pool: { days: stale } })).reasons).toContain('INVENTORY_STALE')
  })
  it('FREE_SALE on a pooled plan does not consume or require the pool', () => {
    const d = decide(plan({ rows: rowsWith(() => ({ inventoryMode: 'FREE_SALE' })), poolId: 'p', pool: { days: [] } }))
    expect(d.eligible).toBe(true)
  })
  it('nightStock reports pool remaining for pooled plans and the row otherwise', () => {
    const p = plan({ poolId: 'p', pool: { days: poolDays(5, 2, 1) } })
    expect(nightStock(p, '2026-10-15')).toEqual({ mode: 'ALLOTMENT', remaining: 2 })
    expect(nightStock(plan({ rows: rowsWith(() => ({ allotment: 4, sold: 1 })) }), '2026-10-15')).toEqual({ mode: 'ALLOTMENT', remaining: 3 })
    expect(nightStock(plan({ rows: rowsWith(() => ({ inventoryMode: 'FREE_SALE' })) }), '2026-10-15')).toEqual({ mode: 'FREE_SALE', remaining: null })
    expect(nightStock(plan({ rows: [] }), '2026-10-15')).toEqual({ mode: null, remaining: null })
  })
})

describe('closed to arrival / departure and stay length', () => {
  it('CTA applies to the first night only', () => {
    expect(decide(plan({ rows: rowsWith((x) => (x === '2026-10-15' ? { closedToArrival: true } : {})) })).reasons).toContain('CLOSED_TO_ARRIVAL')
    expect(decide(plan({ rows: rowsWith((x) => (x === '2026-10-16' ? { closedToArrival: true } : {})) })).eligible).toBe(true)
  })
  it('CTD applies to the DEPARTURE date row', () => {
    const d = decide(plan({ rows: rowsWith(() => ({}), { closedToDeparture: true }) }))
    expect(d.eligible).toBe(false); expect(d.reasons).toContain('CLOSED_TO_DEPARTURE')
  })
  it('CTD on a night the guest stays through (not the departure) does not block', () => {
    expect(decide(plan({ rows: rowsWith((x) => (x === '2026-10-16' ? { closedToDeparture: true } : {})) })).eligible).toBe(true)
  })
  it('CTD on the check-in date does not block that stay', () => {
    expect(decide(plan({ rows: rowsWith((x) => (x === '2026-10-15' ? { closedToDeparture: true } : {})) })).eligible).toBe(true)
  })
  it('a missing departure row is not closed', () => {
    expect(decide(plan({ rows: DATES.map((d) => row(d)) })).eligible).toBe(true)
  })
  it('a CTD row exists only as a departure: departing the day after a closed date is allowed', () => {
    expect(decide(plan({ rows: [...DATES.map((d) => row(d)), row('2026-10-18', { closedToDeparture: false })] })).eligible).toBe(true)
  })
  it('row minStay greater than the stay blocks; minStay equal passes', () => {
    expect(decide(plan({ rows: rowsWith((x) => (x === '2026-10-16' ? { minStay: 4 } : {})) })).reasons).toContain('MIN_STAY_NOT_MET')
    expect(decide(plan({ rows: rowsWith((x) => (x === '2026-10-16' ? { minStay: 3 } : {})) })).eligible).toBe(true)
  })
})

describe('hotel-local release deadline', () => {
  // check-in 2026-10-15, 3 days, 18:00 Dubai => deadline 2026-10-12T14:00:00Z
  const p = plan({ releaseDays: 3, releaseTime: '18:00' })
  it('sells one millisecond before the deadline', () => expect(decide(p, { now: new Date('2026-10-12T13:59:59.999Z') }).eligible).toBe(true))
  it('does not sell at the deadline', () => expect(decide(p, { now: new Date('2026-10-12T14:00:00.000Z') }).reasons).toContain('RELEASE_DAYS_NOT_MET'))
  it('does not sell after the deadline', () => expect(decide(p, { now: new Date('2026-10-13T00:00:00.000Z') }).reasons).toContain('RELEASE_DAYS_NOT_MET'))
  it('a missing hotel time zone fails closed', () => {
    const snap: ContractedStaySnapshot = { ...buildStaySnapshot(plan(), { status: 'MAPPED', hotelId: 'h1' }, { status: 'MAPPED' }, DATES), hotelTimeZone: '' }
    expect(evaluateContractedStay(snap, base).reasons).toContain('RELEASE_DAYS_NOT_MET')
  })
})

describe('freshness', () => {
  it('rowIsFresh: strictly before freshUntil; admin without expiry is fresh; supplier without expiry is stale', () => {
    const until = '2026-10-05T09:00:00.000Z'
    expect(rowIsFresh('SUPPLIER_API', until, new Date('2026-10-05T08:59:59.999Z'))).toBe(true)
    expect(rowIsFresh('SUPPLIER_API', until, new Date(until))).toBe(false)
    expect(rowIsFresh('ADMIN', null, NOW)).toBe(true)
    expect(rowIsFresh('CONTRACT', null, NOW)).toBe(true)
    expect(rowIsFresh('SUPPLIER_FEED', null, NOW)).toBe(false)
    expect(rowIsFresh('ADMIN', 'not-a-date', NOW)).toBe(false)
  })
  it('a stale night fails closed with INVENTORY_STALE even when stock exists', () => {
    const d = decide(plan({ rows: rowsWith((x) => (x === '2026-10-17' ? { freshUntil: new Date(NOW.getTime() - 1) } : {})) }))
    expect(d).toMatchObject({ eligible: false, availabilityStatus: 'unavailable', totalMinor: null }); expect(d.reasons).toContain('INVENTORY_STALE')
  })
  it('a supplier-sourced row with no freshUntil is stale; with a future freshUntil it sells', () => {
    expect(decide(plan({ rows: rowsWith(() => ({ source: 'SUPPLIER_API' })) })).reasons).toContain('INVENTORY_STALE')
    expect(decide(plan({ rows: rowsWith(() => ({ source: 'SUPPLIER_API', freshUntil: new Date(NOW.getTime() + 60_000) })) })).eligible).toBe(true)
  })
})

describe('occupancy and rooms', () => {
  it('rooms beyond remaining stock are refused, not clipped', () => {
    expect(decide(plan({ rows: rowsWith(() => ({ allotment: 2 })) }), { rooms: 3 }).reasons).toContain('NO_INVENTORY')
    expect(decide(plan({ rows: rowsWith(() => ({ allotment: 2 })) }), { rooms: 2 })).toMatchObject({ eligible: true, totalMinor: 180_000n })
  })
})
