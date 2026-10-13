import { discountedNets, leadDays, promotionApplies, selectPromotion, validatePromotions, type PromotionContext, type PromotionRule } from './promotions'

const rule = (over: Partial<PromotionRule> & Pick<PromotionRule, 'kind'>): PromotionRule => ({ id: 'a', name: 'Promo', percentBp: null, minLeadDays: null, maxLeadDays: null, minNights: null, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, ...over })
const dates = ['2026-11-10', '2026-11-11', '2026-11-12']
const ctx = (over: Partial<PromotionContext> = {}): PromotionContext => ({ today: '2026-10-12', checkIn: '2026-11-10', dates, ...over })

describe('promotions (ADR 0058, S10a)', () => {
  it('lead time is whole days from the hotel\'s today to check-in', () => {
    expect(leadDays('2026-10-12', '2026-11-10')).toBe(29)
    expect(leadDays('2026-10-12', '2026-10-12')).toBe(0)
    expect(leadDays('2026-12-30', '2027-01-02')).toBe(3) // across a year end
  })

  describe('when a promotion applies', () => {
    it('early bird needs the lead; last minute needs it to be short and not in the past', () => {
      expect(promotionApplies(rule({ kind: 'EARLY_BIRD', percentBp: 1000, minLeadDays: 29 }), ctx())).toBe(true)
      expect(promotionApplies(rule({ kind: 'EARLY_BIRD', percentBp: 1000, minLeadDays: 30 }), ctx())).toBe(false)
      expect(promotionApplies(rule({ kind: 'LAST_MINUTE', percentBp: 1000, maxLeadDays: 29 }), ctx())).toBe(true)
      expect(promotionApplies(rule({ kind: 'LAST_MINUTE', percentBp: 1000, maxLeadDays: 28 }), ctx())).toBe(false)
      expect(promotionApplies(rule({ kind: 'LAST_MINUTE', percentBp: 1000, maxLeadDays: 5 }), ctx({ today: '2026-11-12' }))).toBe(false) // check-in already past
    })
    it('long stay and free nights need enough nights; free nights must leave a paid night', () => {
      expect(promotionApplies(rule({ kind: 'LONG_STAY', percentBp: 500, minNights: 3 }), ctx())).toBe(true)
      expect(promotionApplies(rule({ kind: 'LONG_STAY', percentBp: 500, minNights: 4 }), ctx())).toBe(false)
      expect(promotionApplies(rule({ kind: 'FREE_NIGHTS', minNights: 3, freeNights: 1 }), ctx())).toBe(true)
      expect(promotionApplies(rule({ kind: 'FREE_NIGHTS', minNights: 3, freeNights: 3 }), ctx())).toBe(false)
    })
    it('booking and stay windows are inclusive; the stay window needs EVERY night inside it', () => {
      const base = { kind: 'LONG_STAY' as const, percentBp: 500, minNights: 2 }
      expect(promotionApplies(rule({ ...base, bookFrom: '2026-10-12', bookTo: '2026-10-12' }), ctx())).toBe(true)
      expect(promotionApplies(rule({ ...base, bookFrom: '2026-10-13' }), ctx())).toBe(false)
      expect(promotionApplies(rule({ ...base, bookTo: '2026-10-11' }), ctx())).toBe(false)
      expect(promotionApplies(rule({ ...base, stayFrom: '2026-11-10', stayTo: '2026-11-12' }), ctx())).toBe(true)
      expect(promotionApplies(rule({ ...base, stayTo: '2026-11-11' }), ctx())).toBe(false)
      expect(promotionApplies(rule({ ...base, stayFrom: '2026-11-11' }), ctx())).toBe(false)
    })
    it('an unknown hotel today disables anything that depends on it, and nothing else', () => {
      expect(promotionApplies(rule({ kind: 'EARLY_BIRD', percentBp: 1000, minLeadDays: 1 }), ctx({ today: null }))).toBe(false)
      expect(promotionApplies(rule({ kind: 'LONG_STAY', percentBp: 1000, minNights: 2, bookFrom: '2026-01-01' }), ctx({ today: null }))).toBe(false)
      expect(promotionApplies(rule({ kind: 'LONG_STAY', percentBp: 1000, minNights: 2 }), ctx({ today: null }))).toBe(true)
    })
  })

  describe('the arithmetic', () => {
    it('percent is half up per night: 10% of 15,005 is 1,500.5, which rounds to 1,501', () => {
      expect(discountedNets(rule({ kind: 'LONG_STAY', percentBp: 1000, minNights: 2 }), [15_005n, 15_004n], ['a', 'b'])).toEqual([13_504n, 13_504n])
    })
    it('the discount never takes a night below 1 minor unit', () => {
      expect(discountedNets(rule({ kind: 'LONG_STAY', percentBp: 9000, minNights: 2 }), [1n, 2n, 10n], ['a', 'b', 'c'])).toEqual([1n, 1n, 1n])
    })
    it('free nights zero the cheapest nights, the later date on a tie', () => {
      const r = rule({ kind: 'FREE_NIGHTS', minNights: 3, freeNights: 1 })
      expect(discountedNets(r, [300n, 100n, 200n], dates)).toEqual([300n, 0n, 200n])
      expect(discountedNets(r, [100n, 100n, 200n], dates)).toEqual([100n, 0n, 200n]) // tie: the later of the two cheapest
      expect(discountedNets(rule({ kind: 'FREE_NIGHTS', minNights: 4, freeNights: 2 }), [400n, 100n, 100n, 300n], ['d1', 'd2', 'd3', 'd4'])).toEqual([400n, 0n, 0n, 300n])
    })
    it('amounts beyond float precision stay exact', () => {
      const big = 9_007_199_254_740_993n
      expect(discountedNets(rule({ kind: 'LONG_STAY', percentBp: 1000, minNights: 2 }), [big], ['a'])[0]).toBe(big - (big * 1000n + 5000n) / 10000n)
    })
  })

  describe('choosing one promotion', () => {
    const nets = [10_000n, 10_000n, 10_000n]
    it('applies the one that saves the most; promotions never stack', () => {
      const small = rule({ id: 'a', kind: 'LONG_STAY', name: 'Small', percentBp: 500, minNights: 2 })
      const big = rule({ id: 'b', kind: 'EARLY_BIRD', name: 'Big', percentBp: 2000, minLeadDays: 10 })
      const picked = selectPromotion([small, big], ctx(), nets)!
      expect(picked.applied).toEqual({ id: 'b', kind: 'EARLY_BIRD', name: 'Big', savingMinor: 6_000n })
      expect(picked.nets).toEqual([8_000n, 8_000n, 8_000n])
    })
    it('compares the saving on the actual stay: one free night (10,000) beats 20% (6,000), and 40% (12,000) beats the free night', () => {
      const free = rule({ id: 'f', kind: 'FREE_NIGHTS', name: 'Pay 2 stay 3', minNights: 3, freeNights: 1 })
      const twenty = rule({ id: 'p', kind: 'LONG_STAY', name: '20%', percentBp: 2000, minNights: 3 })
      const forty = rule({ id: 'q', kind: 'LONG_STAY', name: '40%', percentBp: 4000, minNights: 3 })
      expect(selectPromotion([free, twenty], ctx(), nets)!.applied).toMatchObject({ name: 'Pay 2 stay 3', savingMinor: 10_000n })
      expect(selectPromotion([free, forty], ctx(), nets)!.applied).toMatchObject({ name: '40%', savingMinor: 12_000n })
    })
    it('a tie goes to the lowest id, whatever the order given', () => {
      const x = rule({ id: 'x', kind: 'LONG_STAY', name: 'X', percentBp: 1000, minNights: 2 })
      const m = rule({ id: 'm', kind: 'LONG_STAY', name: 'M', percentBp: 1000, minNights: 2 })
      expect(selectPromotion([x, m], ctx(), nets)!.applied.id).toBe('m')
      expect(selectPromotion([m, x], ctx(), nets)!.applied.id).toBe('m')
    })
    it('returns nothing when none applies or none saves anything', () => {
      expect(selectPromotion([rule({ kind: 'EARLY_BIRD', percentBp: 1000, minLeadDays: 100 })], ctx(), nets)).toBeNull()
      expect(selectPromotion([rule({ kind: 'LONG_STAY', percentBp: 1000, minNights: 2 })], ctx(), [1n, 1n, 1n])).toBeNull() // already at the floor
      expect(selectPromotion([], ctx(), nets)).toBeNull()
    })
  })

  describe('validating a plan\'s promotions on write', () => {
    it('accepts one of each kind', () => {
      expect(validatePromotions([
        { kind: 'EARLY_BIRD', name: 'Early', percentBp: 1500, minLeadDays: 30 }, { kind: 'LAST_MINUTE', name: 'Late', percentBp: 1000, maxLeadDays: 3 },
        { kind: 'LONG_STAY', name: 'Long', percentBp: 800, minNights: 7, stayFrom: '2026-11-01', stayTo: '2026-12-31' }, { kind: 'FREE_NIGHTS', name: 'Pay 6 stay 7', minNights: 7, freeNights: 1, bookFrom: '2026-10-01', bookTo: '2026-10-31' },
      ])).toEqual([])
    })
    it('reports every problem at once', () => {
      const codes = validatePromotions([
        { kind: 'SALE', name: 'x' }, { kind: 'EARLY_BIRD', name: ' ', percentBp: 9500, minLeadDays: 0 }, { kind: 'EARLY_BIRD', name: 'dup', percentBp: 100, minLeadDays: 5 }, { kind: 'LONG_STAY', name: 'DUP', percentBp: 100, minNights: 1 },
        { kind: 'FREE_NIGHTS', name: 'f', minNights: 3, freeNights: 3 }, { kind: 'FREE_NIGHTS', name: 'g', minNights: 3, freeNights: 1, percentBp: 10 }, { kind: 'LAST_MINUTE', name: 'l', percentBp: 10, maxLeadDays: 2, minLeadDays: 1 },
        { kind: 'LONG_STAY', name: 'w', percentBp: 100, minNights: 2, bookFrom: '2026-02-30', stayFrom: '2026-12-01', stayTo: '2026-11-01' },
      ]).map((i) => i.code)
      expect(codes).toEqual(expect.arrayContaining(['PROMOTION_KIND_INVALID', 'PROMOTION_NAME_INVALID', 'PROMOTION_PERCENT_INVALID', 'PROMOTION_LEAD_INVALID', 'PROMOTION_NAME_DUPLICATE', 'PROMOTION_NIGHTS_INVALID', 'PROMOTION_FREE_NIGHTS_INVALID', 'PROMOTION_WINDOW_INVALID']))
    })
    it('limits the number per plan', () => {
      const many = Array.from({ length: 21 }, (_, i) => ({ kind: 'LONG_STAY', name: `p${i}`, percentBp: 100, minNights: 2 }))
      expect(validatePromotions(many)[0]!.code).toBe('PROMOTION_TOO_MANY')
    })
  })
})
