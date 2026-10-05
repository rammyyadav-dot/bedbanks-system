import { capacityFingerprint, normaliseCapacityEdit, planCapacityEdit, type PoolDayState } from './pool-capacity-rules'
import { attributeNight } from './pool-consumption'

const day = (capacity: number, sold = 0, held = 0, id = 'd', updated = 1): PoolDayState => ({ id, capacity, sold, held, updatedAt: new Date(updated) })
const value = (over: Record<string, unknown> = {}) => normaliseCapacityEdit({ startDate: '2030-06-03', endDate: '2030-06-09', capacity: 5, ...over } as never)

describe('pool capacity editor rules (PC)', () => {
  describe('normaliseCapacityEdit', () => {
    it('PC-01 accepts a valid range, weekday filter and capacity', () => {
      expect(value({ weekdays: ['MON', 'FRI', 'MON'] }).value).toEqual({ startDate: '2030-06-03', endDate: '2030-06-09', weekdays: ['MON', 'FRI'], capacity: 5 })
    })
    it('PC-02 blank is not zero: a missing, null or empty capacity is refused, zero is accepted', () => {
      for (const capacity of [undefined, null, '']) expect(value({ capacity }).errors.join(' ')).toMatch(/Blank means unchanged/)
      expect(value({ capacity: 0 }).value?.capacity).toBe(0)
    })
    it('PC-03 rejects negative, fractional, oversized, non-numeric capacity without clamping', () => {
      for (const capacity of [-1, 1.5, 10_000, '5', Number.NaN, Infinity]) expect({ capacity, ok: value({ capacity }).value === null }).toEqual({ capacity, ok: true })
      expect(value({ capacity: 9999 }).value?.capacity).toBe(9999)
    })
    it('PC-04 rejects an invalid, reversed or oversized range and unknown fields', () => {
      expect(value({ startDate: '2030-02-30' }).errors.join()).toMatch(/startDate/)
      expect(value({ endDate: 'soon' }).errors.join()).toMatch(/endDate/)
      expect(value({ endDate: '2030-06-02' }).errors.join()).toMatch(/before startDate/)
      expect(value({ endDate: '2031-06-04' }).errors.join()).toMatch(/limited to 366/)
      expect(value({ endDate: '2031-06-03' }).value).not.toBeNull() // exactly 366 nights
      expect(value({ weekdays: ['FUNDAY'] }).errors.join()).toMatch(/weekdays/)
      expect(value({ tenantId: 'x' }).errors.join()).toMatch(/tenantId is not a supported field/)
      expect(normaliseCapacityEdit(null).value).toBeNull()
    })
  })

  describe('planCapacityEdit', () => {
    const v = value({ endDate: '2030-06-05' }).value!
    it('PC-05 classifies change and unchanged and computes before/after available from the one formula; a night with no pool row is INVALID, never created', () => {
      const days = new Map([['2030-06-03', day(8, 2, 1, 'a')], ['2030-06-04', day(5, 1, 1, 'b')]])
      const p = planCapacityEdit(v, days, '2030-06-01')
      expect(p.counts).toEqual({ dates: 3, willChange: 1, unchanged: 1, invalid: 1 })
      expect(p.rows[0]).toMatchObject({ outcome: 'CHANGE', before: { capacity: 8, sold: 2, held: 1, available: 5 }, after: { capacity: 5, available: 2 } })
      expect(p.rows[1]).toMatchObject({ outcome: 'UNCHANGED', after: { capacity: 5, available: 3 } })
      expect(p.rows[2]).toMatchObject({ outcome: 'INVALID', before: null, after: null })
      expect(p.rows[2].problems[0]).toMatch(/no pool stock row \(unknown, not zero\)/)
    })
    it('PC-06 refuses a decrease below sold + held and names the numbers; equal to the floor is allowed; zero is allowed only on an empty night', () => {
      const days = new Map([['2030-06-03', day(8, 2, 1)], ['2030-06-04', day(8, 3, 2)], ['2030-06-05', day(8, 0, 0)]])
      const p = planCapacityEdit(v, days, '2030-06-01')
      expect(p.rows.map((r) => r.outcome)).toEqual(['CHANGE', 'CHANGE', 'CHANGE']) // floor 3, 5, 0 vs capacity 5
      const tight = planCapacityEdit(value({ endDate: '2030-06-05', capacity: 4 }).value!, days, '2030-06-01')
      expect(tight.rows.map((r) => r.outcome)).toEqual(['CHANGE', 'INVALID', 'CHANGE'])
      expect(tight.rows[1].problems[0]).toMatch(/capacity 4 is below the 5 unit\(s\) already sold or held \(sold 3, held 2\)/)
      const zero = planCapacityEdit(value({ endDate: '2030-06-05', capacity: 0 }).value!, days, '2030-06-01')
      expect(zero.rows.map((r) => r.outcome)).toEqual(['INVALID', 'INVALID', 'CHANGE'])
      expect(zero.rows[2].after).toEqual({ capacity: 0, available: 0 })
    })
    it('PC-07 a night before the hotel-local today is invalid, today is editable', () => {
      const p = planCapacityEdit(v, new Map(), '2030-06-04')
      expect(p.rows.map((r) => r.outcome)).toEqual(['INVALID', 'INVALID', 'INVALID'])
      const stocked = planCapacityEdit(v, new Map([['2030-06-04', day(8)], ['2030-06-05', day(8)]]), '2030-06-04')
      expect(stocked.rows.map((r) => r.outcome)).toEqual(['INVALID', 'CHANGE', 'CHANGE'])
      expect(p.rows[0].problems[0]).toMatch(/before the hotel's local today \(2030-06-04\)/)
    })
    it('PC-08 weekday filtering selects only those nights', () => {
      const p = planCapacityEdit(value({ weekdays: ['TUE', 'THU'] }).value!, new Map(), '2030-06-01')
      expect(p.rows.map((r) => `${r.date}:${r.weekday}`)).toEqual(['2030-06-04:TUE', '2030-06-06:THU'])
      expect(planCapacityEdit(value({ startDate: '2030-06-03', endDate: '2030-06-03', weekdays: ['FRI'] }).value!, new Map(), '2030-06-01').errors).toEqual(['The selected range and weekdays contain no dates'])
    })
  })

  describe('capacityFingerprint', () => {
    const v = value({ endDate: '2030-06-04' }).value!
    const dates = ['2030-06-03', '2030-06-04']
    const fp = (days: Map<string, PoolDayState>, over: Partial<Parameters<typeof capacityFingerprint>[0]> = {}) => capacityFingerprint({ poolId: 'p', status: 'ACTIVE', value: v, dates, days, ...over })
    const base = new Map([['2030-06-03', day(8, 1, 1)], ['2030-06-04', day(8)]])
    it('PC-09 is stable for identical state and changes with capacity, consumption, version, absence, status or request', () => {
      const a = fp(base)
      expect(fp(new Map(base))).toBe(a)
      expect(a).toMatch(/^[0-9a-f]{64}$/)
      for (const changed of [
        fp(new Map([...base, ['2030-06-03', day(9, 1, 1)]])), fp(new Map([...base, ['2030-06-03', day(8, 2, 1)]])), fp(new Map([...base, ['2030-06-03', day(8, 1, 2)]])),
        fp(new Map([...base, ['2030-06-03', day(8, 1, 1, 'd', 2)]])), fp(new Map([['2030-06-03', day(8, 1, 1)]])), fp(base, { status: 'ARCHIVED' }),
        fp(base, { value: { ...v, capacity: 6 } }), fp(base, { poolId: 'q' }),
      ]) expect(changed).not.toBe(a)
    })
  })
})

describe('pool consumption attribution (PC)', () => {
  const d = { id: 'day1', capacity: 5, sold: 2, held: 2 }
  const n = (ratePlanId: string, holdStatus: string, quantity: number, poolDayId = 'day1') => ({ poolDayId, ratePlanId, holdStatus, quantity })

  it('PC-10 attributes held and sold by hold status and reconciles with the counter', () => {
    const r = attributeNight('2030-06-03', d, [n('A', 'HELD', 1), n('B', 'PROCESSING', 1), n('A', 'CONFIRMED', 2)])
    expect(r.plans).toEqual([{ ratePlanId: 'A', held: 1, sold: 2 }, { ratePlanId: 'B', held: 1, sold: 0 }])
    expect(r).toMatchObject({ held: 2, sold: 2, available: 1, unattributedHeld: 0, unattributedSold: 0, consistent: true })
  })
  it('PC-11 terminal statuses occupy nothing: released, expired and failed holds never count', () => {
    const r = attributeNight('2030-06-03', d, [n('A', 'RELEASED', 2), n('A', 'EXPIRED', 1), n('B', 'FAILED', 1), n('B', 'RECHECKED', 1), n('A', 'HELD', 1)])
    expect(r.plans).toEqual([{ ratePlanId: 'A', held: 1, sold: 0 }])
    expect(r).toMatchObject({ unattributedHeld: 1, unattributedSold: 2, consistent: true })
  })
  it('PC-12 consumption the holds do not explain is explicit and unattributed, never spread over plans', () => {
    const r = attributeNight('2030-06-03', { id: 'day1', capacity: 9, sold: 4, held: 3 }, [n('A', 'CONFIRMED', 1), n('A', 'HELD', 1)])
    expect(r).toMatchObject({ unattributedHeld: 2, unattributedSold: 3, consistent: true })
    expect(r.plans).toEqual([{ ratePlanId: 'A', held: 1, sold: 1 }])
  })
  it('PC-13 holds claiming more than the counter holds are reported inconsistent with the negative figure, not hidden', () => {
    const r = attributeNight('2030-06-03', { id: 'day1', capacity: 5, sold: 0, held: 1 }, [n('A', 'HELD', 2)])
    expect(r).toMatchObject({ unattributedHeld: -1, consistent: false })
  })
  it('PC-14 only hold nights recorded against this pool day count; a plan row counter or another day never leaks in', () => {
    const r = attributeNight('2030-06-03', d, [n('A', 'HELD', 2, 'other-day'), n('A', 'CONFIRMED', 1, 'day1')])
    expect(r.plans).toEqual([{ ratePlanId: 'A', held: 0, sold: 1 }])
  })
  it('PC-15 a missing pool night is unknown, never zero', () => {
    expect(attributeNight('2030-06-03', null, [n('A', 'HELD', 1)])).toEqual({ date: '2030-06-03', exists: false, capacity: null, sold: null, held: null, available: null, plans: [], unattributedHeld: null, unattributedSold: null, consistent: null })
  })
  it('PC-16 attribution depends only on the recorded plan: membership is not an input, so history survives a plan leaving the pool', () => {
    expect(attributeNight.length).toBe(3) // (date, day, nights): there is no membership parameter
    const r = attributeNight('2030-06-03', d, [n('FORMER', 'CONFIRMED', 2), n('CURRENT', 'HELD', 2)])
    expect(r.plans.map((p) => p.ratePlanId)).toEqual(['CURRENT', 'FORMER'])
  })
})
