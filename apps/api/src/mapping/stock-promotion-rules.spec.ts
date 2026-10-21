import { mayFeedWriteNight, omittedNightsToClose, planStockCount, routeRoomWideStock, type NightState } from './stock-promotion-rules'

describe('stock count meaning (ADR 0083 decision 3b)', () => {
  it('REMAINING adds the feed count to what is already sold and held, so we never sell more than the supplier has', () => {
    expect(planStockCount({ semantics: 'REMAINING', count: 4, sold: 3, held: 1 })).toEqual({ ok: true, allotment: 8 })
    expect(planStockCount({ semantics: 'REMAINING', count: 0, sold: 3, held: 1 })).toEqual({ ok: true, allotment: 4 })
  })

  it('TOTAL becomes the allotment, and a total below sold + held is refused, never clamped', () => {
    expect(planStockCount({ semantics: 'TOTAL', count: 10, sold: 3, held: 1 })).toEqual({ ok: true, allotment: 10 })
    expect(planStockCount({ semantics: 'TOTAL', count: 4, sold: 3, held: 1 })).toEqual({ ok: true, allotment: 4 })
    expect(planStockCount({ semantics: 'TOTAL', count: 3, sold: 3, held: 1 })).toEqual({ ok: false, block: 'COUNT_BELOW_COMMITTED' })
  })

  it('refuses undeclared semantics, negative or fractional numbers, and values past the stock limit', () => {
    for (const semantics of [undefined, null, 'remaining' as never, '' as never]) expect(planStockCount({ semantics, count: 1, sold: 0, held: 0 })).toEqual({ ok: false, block: 'COUNT_SEMANTICS_UNDECLARED' })
    for (const bad of [{ count: -1, sold: 0, held: 0 }, { count: 1.5, sold: 0, held: 0 }, { count: 1, sold: -1, held: 0 }, { count: 1, sold: 0, held: 0.5 }, { count: Number.NaN, sold: 0, held: 0 }]) expect(planStockCount({ semantics: 'TOTAL', ...bad })).toEqual({ ok: false, block: 'COUNT_INVALID' })
    expect(planStockCount({ semantics: 'TOTAL', count: 10_000, sold: 0, held: 0 })).toEqual({ ok: false, block: 'COUNT_INVALID' })
    expect(planStockCount({ semantics: 'REMAINING', count: 9_999, sold: 1, held: 0 })).toEqual({ ok: false, block: 'COUNT_INVALID' })
    expect(planStockCount({ semantics: 'REMAINING', count: 9_998, sold: 1, held: 0 })).toEqual({ ok: true, allotment: 9_999 })
  })
})

describe('room-wide stock routing (decision 3a)', () => {
  const plan = (ratePlanId: string, poolId: string | null, poolActive = true) => ({ ratePlanId, poolId, poolActive })
  it('goes to the one active pool all the room\'s feed-managed plans share', () => {
    expect(routeRoomWideStock([plan('a', 'pool1'), plan('b', 'pool1')])).toEqual({ ok: true, poolId: 'pool1' })
    expect(routeRoomWideStock([plan('a', 'pool1')])).toEqual({ ok: true, poolId: 'pool1' })
  })
  it('is blocked, with the offending plans, when any plan is unpooled, pools differ, a pool is not active, or there are no plans', () => {
    expect(routeRoomWideStock([plan('b', null), plan('a', null)])).toEqual({ ok: false, block: 'NEEDS_POOL', offending: ['a', 'b'] })
    expect(routeRoomWideStock([plan('a', 'pool1'), plan('b', null)])).toEqual({ ok: false, block: 'NEEDS_POOL', offending: ['b'] })
    expect(routeRoomWideStock([plan('a', 'pool1'), plan('b', 'pool2')])).toEqual({ ok: false, block: 'NEEDS_POOL', offending: ['b'] })
    expect(routeRoomWideStock([plan('a', 'pool1', false), plan('b', 'pool1', false)])).toEqual({ ok: false, block: 'NEEDS_POOL', offending: ['a', 'b'] })
    expect(routeRoomWideStock([])).toEqual({ ok: false, block: 'NEEDS_POOL', offending: [] })
  })
})

describe('a person\'s close is sticky (decision 3c)', () => {
  const open = { stopSell: false, mode: 'ALLOTMENT' as const }
  const closedBy = (source: string, patch: Partial<NightState> = {}): NightState => ({ source, stopSell: true, mode: 'ALLOTMENT', ...patch })
  it('never lets the feed reopen a night a person stop-sold or closed', () => {
    expect(mayFeedWriteNight(closedBy('ADMIN'), open)).toEqual({ allowed: false, reason: 'MANUAL_CLOSE_STICKY' })
    expect(mayFeedWriteNight(closedBy('ADMIN', { stopSell: false, mode: 'CLOSED' }), open)).toEqual({ allowed: false, reason: 'MANUAL_CLOSE_STICKY' })
    expect(mayFeedWriteNight(closedBy('ADMIN'), { stopSell: false, mode: 'FREE_SALE' })).toEqual({ allowed: false, reason: 'MANUAL_CLOSE_STICKY' })
  })
  it('lets the feed keep or add closes, and write nights a person has not closed or has reopened', () => {
    expect(mayFeedWriteNight(closedBy('ADMIN'), { stopSell: true, mode: 'ALLOTMENT' })).toEqual({ allowed: true })
    expect(mayFeedWriteNight(closedBy('ADMIN'), { stopSell: false, mode: 'CLOSED' })).toEqual({ allowed: true })
    expect(mayFeedWriteNight({ source: 'ADMIN', stopSell: false, mode: 'ALLOTMENT' }, open)).toEqual({ allowed: true })
    expect(mayFeedWriteNight(null, open)).toEqual({ allowed: true })
  })
  it('does not protect a close the feed itself made', () => {
    expect(mayFeedWriteNight(closedBy('SUPPLIER_FEED'), open)).toEqual({ allowed: true })
    expect(mayFeedWriteNight(closedBy('CONTRACT'), open)).toEqual({ allowed: true })
  })
})

describe('nights a complete feed omits (decision 4)', () => {
  const state = (patch: Partial<NightState> = {}): NightState => ({ source: 'SUPPLIER_FEED', stopSell: false, mode: 'ALLOTMENT', ...patch })
  const promoted = new Map<string, NightState>([['2027-03-01', state()], ['2027-03-02', state()], ['2027-03-10', state()], ['2027-03-11', state()], ['2027-03-12', state({ stopSell: true })], ['2027-02-27', state()], ['2027-06-30', state()]])
  const call = (incoming: string[], coverageDays: number | null | undefined, today = '2027-03-01') => omittedNightsToClose({ promoted, incomingNights: new Set(incoming), today, coverageDays })

  it('closes omitted nights inside the declared window, including both ends, and leaves the rest alone', () => {
    // window 2027-03-01 .. 2027-03-11 with 10 days
    expect(call(['2027-03-01'], 10)).toEqual(['2027-03-02', '2027-03-10', '2027-03-11'])
    expect(call([], 9)).toEqual(['2027-03-01', '2027-03-02', '2027-03-10'])
  })
  it('never touches nights before today, beyond the window, already closed, or still mentioned', () => {
    const closed = call([], 10)
    expect(closed).not.toContain('2027-02-27')
    expect(closed).not.toContain('2027-06-30')
    expect(closed).not.toContain('2027-03-12')
    expect(call(['2027-03-02', '2027-03-10', '2027-03-11', '2027-03-01'], 10)).toEqual([])
  })
  it('closes nothing when the profile declares no coverage, or an invalid one', () => {
    for (const coverageDays of [undefined, null, 0, -1, 731, 2.5]) expect(call([], coverageDays as never)).toEqual([])
  })
  it('treats a CLOSED night as already closed', () => {
    const p = new Map<string, NightState>([['2027-03-05', state({ mode: 'CLOSED' })], ['2027-03-06', state()]])
    expect(omittedNightsToClose({ promoted: p, incomingNights: new Set(), today: '2027-03-01', coverageDays: 30 })).toEqual(['2027-03-06'])
  })
})
