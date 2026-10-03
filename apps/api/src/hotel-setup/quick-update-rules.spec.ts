import { dayInZone, expandDates, normaliseQuickUpdate, planQuickUpdate, type AvailState, type PlanInfo, type RateState } from './quick-update-rules'

const plan = (over: Partial<PlanInfo> = {}): PlanInfo => ({ id: 'p1', status: 'ACTIVE', currency: 'AED', occupancy: 2, contractFrom: '2026-01-01', contractTo: '2027-12-31', ...over })
const req = (changes: object, scope: object = {}) => ({ scope: { ratePlanIds: ['p1'], ranges: [{ from: '2026-11-02', to: '2026-11-08' }], ...scope }, changes })
const run = (changes: object, o: { scope?: object; plans?: PlanInfo[]; rates?: Record<string, RateState>; avail?: Record<string, AvailState>; today?: string } = {}) => {
  const n = normaliseQuickUpdate(req(changes, o.scope) as never)
  if (!n.value) throw new Error(`invalid request: ${n.errors.join('; ')}`)
  return planQuickUpdate({ value: n.value, plans: new Map((o.plans ?? [plan()]).map((p) => [p.id, p])), rates: new Map(Object.entries(o.rates ?? {})), avail: new Map(Object.entries(o.avail ?? {})), today: o.today ?? '2026-10-01' })
}
const A = (over: Partial<AvailState> = {}): AvailState => ({ allotment: 5, sold: 1, held: 1, stopSell: false, minStay: 1, closedToArrival: false, ...over })

describe('normaliseQuickUpdate', () => {
  it('requires scope and at least one change, and rejects unknown keys without echoing values', () => {
    expect(normaliseQuickUpdate(undefined).errors.join(' ')).toMatch(/scope: is required.*changes: is required/)
    expect(normaliseQuickUpdate(req({}) as never).errors.join(' ')).toMatch(/choose at least one field/)
    const bad = normaliseQuickUpdate({ ...req({ price: { amount: '10', basis: 'SELL' } }), tenantId: 'other-tenant', changes: { price: { amount: '10', basis: 'SELL', secret: 1 }, lockDates: true } } as never).errors.join(' ')
    expect(bad).toMatch(/tenantId: is not a supported field/); expect(bad).toMatch(/changes.lockDates/); expect(bad).toMatch(/changes.price.secret/); expect(bad).not.toContain('other-tenant')
  })
  it.each([
    [{ price: { amount: '', basis: 'SELL' } }, /amount/], [{ price: { amount: '10' } }, /basis/], [{ availability: { allotment: -1 } }, /allotment/], [{ availability: { allotment: 1.5 } }, /allotment/],
    [{ availability: { stopSell: 'YES' } }, /stopSell/], [{ restrictions: { minStay: 0 } }, /minStay/], [{ restrictions: { closedToDeparture: 'SET' } }, /closedToDeparture: is not a supported field/],
  ])('rejects %j', (changes, re) => { expect(normaliseQuickUpdate(req(changes) as never).errors.join(' ')).toMatch(re) })
  it('bounds plans, ranges and range length and requires real dates', () => {
    const base = req({ availability: { stopSell: 'SET' } })
    expect(normaliseQuickUpdate({ ...base, scope: { ...base.scope, ratePlanIds: ['a', 'b', 'c', 'd', 'e', 'f'] } } as never).errors.join(' ')).toMatch(/choose 1 to 5/)
    expect(normaliseQuickUpdate({ ...base, scope: { ...base.scope, ranges: [{ from: '2026-02-30', to: '2026-03-01' }] } } as never).errors.join(' ')).toMatch(/real calendar dates/)
    expect(normaliseQuickUpdate({ ...base, scope: { ...base.scope, ranges: [{ from: '2026-11-05', to: '2026-11-01' }] } } as never).errors.join(' ')).toMatch(/end date is before/)
    expect(normaliseQuickUpdate({ ...base, scope: { ...base.scope, ranges: [{ from: '2026-01-01', to: '2027-02-01' }] } } as never).errors.join(' ')).toMatch(/at most 366/)
    expect(normaliseQuickUpdate({ ...base, scope: { ...base.scope, weekdays: ['FUNDAY'] } } as never).errors.join(' ')).toMatch(/weekdays/)
  })
})

describe('dates and time zones', () => {
  it('expands ranges, dedupes overlaps and filters weekdays (Monday 2026-11-02)', () => {
    expect(expandDates([{ from: '2026-11-02', to: '2026-11-08' }], [])).toHaveLength(7)
    expect(expandDates([{ from: '2026-11-02', to: '2026-11-08' }], ['MON', 'SAT'])).toEqual(['2026-11-02', '2026-11-07'])
    expect(expandDates([{ from: '2026-11-02', to: '2026-11-04' }, { from: '2026-11-03', to: '2026-11-05' }], [])).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'])
  })
  it("uses the hotel's own calendar day, not the server's", () => {
    const instant = new Date('2026-10-01T21:30:00.000Z')
    expect(dayInZone(instant, 'Asia/Dubai')).toBe('2026-10-02') // already tomorrow in Dubai
    expect(dayInZone(instant, 'America/Los_Angeles')).toBe('2026-10-01')
  })
})

describe('planQuickUpdate', () => {
  it('leaves untouched fields alone: a price-only change never produces availability writes', () => {
    const r = run({ price: { amount: '450.50', basis: 'SELL' } }, { avail: { 'p1:2026-11-02': A() } })
    expect(r.rows).toHaveLength(7); expect(r.rows.every((x) => x.outcome === 'CHANGE' && x.nextAvail === null && x.changes.length === 1 && x.changes[0].field === 'price')).toBe(true)
    expect(r.rows[0].changes[0]).toEqual({ field: 'price', from: null, to: '45050', currency: 'AED' })
  })
  it('converts with the currency scale and never through floating point', () => {
    expect(run({ price: { amount: '0.07', basis: 'NET' } }).rows[0].changes[0].to).toBe('7')
    const jpy = run({ price: { amount: '15000', basis: 'NET' } }, { plans: [plan({ currency: 'JPY' })] })
    expect(jpy.rows[0].changes[0]).toMatchObject({ to: '15000', currency: 'JPY' })
    expect(run({ price: { amount: '10.505', basis: 'SELL' } }).rows[0].problems.join(' ')).toMatch(/more decimal places than AED/)
    expect(run({ price: { amount: '1e3', basis: 'SELL' } }).rows[0].problems.join(' ')).toMatch(/not a valid AED amount/)
    expect(run({ price: { amount: '0', basis: 'SELL' } }).rows[0].problems.join(' ')).toMatch(/greater than zero/)
    expect(run({ price: { amount: '-5', basis: 'SELL' } }).rows[0].problems.join(' ')).toMatch(/not a valid/)
    expect(run({ price: { amount: '99999999999.99', basis: 'SELL' } }).rows[0].problems.join(' ')).toMatch(/above the accepted maximum/)
  })
  it('reports NO_CHANGE for an identical price and basis, and a change when only the basis differs', () => {
    const rates = Object.fromEntries(['02', '03', '04', '05', '06', '07', '08'].map((d) => [`p1:2026-11-${d}`, { amountMinor: 45050n, basis: 'SELL' as const }]))
    expect(run({ price: { amount: '450.50', basis: 'SELL' } }, { rates }).counts).toMatchObject({ willChange: 0, unchanged: 7 })
    expect(run({ price: { amount: '450.50', basis: 'NET' } }, { rates }).counts).toMatchObject({ willChange: 7 })
  })
  it('refuses to cut an allotment below what is sold or held, naming the committed inventory', () => {
    const r = run({ availability: { allotment: 1 } }, { avail: { 'p1:2026-11-02': A() } })
    expect(r.rows[0]).toMatchObject({ outcome: 'INVALID' }); expect(r.rows[0].problems.join(' ')).toMatch(/below the 2 already sold or held/)
  })
  it('does not turn unknown inventory into zero: restrictions and stop-sell need an inventory row or an allotment', () => {
    const noRow = run({ availability: { stopSell: 'SET' } })
    expect(noRow.rows.every((x) => x.outcome === 'INVALID' && /missing inventory means unknown, not zero/.test(x.problems.join(' ')))).toBe(true)
    const created = run({ availability: { allotment: 4, stopSell: 'SET' }, restrictions: { minStay: 2 } })
    expect(created.rows[0].nextAvail).toEqual({ create: true, allotment: 4, stopSell: true, minStay: 2, closedToArrival: false })
    expect(created.rows[0].changes.map((c) => c.field).sort()).toEqual(['allotment', 'minStay', 'stopSell'])
  })
  it('keeps stored values when only one restriction is changed', () => {
    const r = run({ restrictions: { closedToArrival: 'SET' } }, { avail: { 'p1:2026-11-02': A({ stopSell: true, minStay: 3, allotment: 9 }) }, scope: { weekdays: ['MON'] } })
    expect(r.rows).toHaveLength(1); expect(r.rows[0].nextAvail).toEqual({ create: false, allotment: 9, stopSell: true, minStay: 3, closedToArrival: true })
  })
  it("rejects dates before today in the hotel's time zone and dates outside the contract", () => {
    const past = run({ availability: { allotment: 1 } }, { today: '2026-11-04', avail: {} })
    expect(past.rows.filter((x) => x.outcome === 'INVALID').map((x) => x.date)).toEqual(['2026-11-02', '2026-11-03'])
    const out = run({ price: { amount: '10', basis: 'SELL' } }, { plans: [plan({ contractTo: '2026-11-04' })] })
    expect(out.rows.filter((x) => x.problems.some((p) => /outside the contract validity/.test(p))).map((x) => x.date)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
  })
  it('refuses one price for plans in different currencies', () => {
    const n = normaliseQuickUpdate(req({ price: { amount: '100', basis: 'SELL' } }, { ratePlanIds: ['p1', 'p2'] }) as never).value!
    const r = planQuickUpdate({ value: n, plans: new Map([['p1', plan()], ['p2', plan({ id: 'p2', currency: 'USD' })]]), rates: new Map(), avail: new Map(), today: '2026-10-01' })
    expect(r.errors.join(' ')).toMatch(/one currency/); expect(r.rows).toHaveLength(0)
    // availability and restrictions carry no amount, so currencies do not matter
    const m = normaliseQuickUpdate(req({ availability: { allotment: 3 } }, { ratePlanIds: ['p1', 'p2'] }) as never).value!
    expect(planQuickUpdate({ value: m, plans: new Map([['p1', plan()], ['p2', plan({ id: 'p2', currency: 'USD' })]]), rates: new Map(), avail: new Map(), today: '2026-10-01' }).errors).toEqual([])
  })
  it('refuses plans that are not DRAFT or ACTIVE, unknown plans, empty selections and oversized batches', () => {
    expect(run({ price: { amount: '10', basis: 'SELL' } }, { plans: [plan({ status: 'EXPIRED' })] }).rows[0].problems.join(' ')).toMatch(/EXPIRED and cannot be changed/)
    const n = normaliseQuickUpdate(req({ price: { amount: '10', basis: 'SELL' } }, { ratePlanIds: ['other'] }) as never).value!
    expect(planQuickUpdate({ value: n, plans: new Map([['p1', plan()]]), rates: new Map(), avail: new Map(), today: '2026-10-01' }).errors.join(' ')).toMatch(/does not belong to this hotel/)
    expect(run({ price: { amount: '10', basis: 'SELL' } }, { scope: { weekdays: ['MON'], ranges: [{ from: '2026-11-03', to: '2026-11-05' }] } }).errors.join(' ')).toMatch(/no dates/)
    const big = normaliseQuickUpdate(req({ price: { amount: '10', basis: 'SELL' } }, { ratePlanIds: ['p1', 'p2', 'p3', 'p4'], ranges: [{ from: '2026-11-01', to: '2027-08-27' }] }) as never).value!
    expect(planQuickUpdate({ value: big, plans: new Map(['p1', 'p2', 'p3', 'p4'].map((id) => [id, plan({ id })])), rates: new Map(), avail: new Map(), today: '2026-10-01' }).errors.join(' ')).toMatch(/exceed the limit of 500/)
  })
})
