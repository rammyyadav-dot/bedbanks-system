import { EXTRA_ADULT_BAND, effectiveGuestLines, resolveGuestPricing, validateGuestPriceLines, type GuestPriceLine } from './guest-pricing'

const limits = { maxAdults: 3, maxChildren: 2, maxOccupancy: 4 }
const child = (minAge: number, maxAge: number, amountMinor: bigint, basis: 'NET' | 'SELL' = 'SELL'): GuestPriceLine => ({ kind: 'CHILD', minAge, maxAge, amountMinor, basis, currency: 'AED' })
const adult = (amountMinor: bigint, basis: 'NET' | 'SELL' = 'SELL'): GuestPriceLine => ({ kind: 'EXTRA_ADULT', ...EXTRA_ADULT_BAND, amountMinor, basis, currency: 'AED' })
const price = (over: Partial<Parameters<typeof resolveGuestPricing>[0]>) => resolveGuestPricing({ planOccupancy: 2, currency: 'AED', adults: 2, children: 0, childAges: [], lines: [], limits, ...over })

describe('guest pricing (ADR 0057, S6)', () => {
  describe('a plan with no lines keeps the original rule', () => {
    it('adults plus children must equal the plan occupancy', () => {
      expect(price({})).toEqual({ mode: 'FLAT', reasons: [] })
      expect(price({ adults: 1, children: 1, childAges: [5] })).toEqual({ mode: 'FLAT', reasons: [] }) // 1 + 1 = 2, as before
      expect(price({ adults: 2, children: 1, childAges: [5] }).reasons).toEqual(['OCCUPANCY_UNSUPPORTED'])
      expect(price({ adults: 1 }).reasons).toEqual(['OCCUPANCY_UNSUPPORTED'])
    })
    it('still respects the room limits', () => {
      expect(price({ planOccupancy: 3, adults: 3, limits: { ...limits, maxAdults: 2 } }).reasons).toEqual(['OCCUPANCY_UNSUPPORTED'])
    })
  })

  describe('a plan with lines prices the party per night', () => {
    const lines = [child(0, 2, 0n), child(3, 11, 15_000n), child(12, 17, 25_000n), adult(30_000n)]
    it('base adults and no children cost nothing extra', () => {
      expect(price({ lines })).toEqual({ mode: 'LINES', reasons: [], extraMinorPerNight: 0n, basis: null })
    })
    it('each child is priced by their own age band; a free band is an explicit zero', () => {
      expect(price({ lines, children: 2, childAges: [1, 8] })).toMatchObject({ reasons: [], extraMinorPerNight: 15_000n, basis: 'SELL' })
      expect(price({ lines, children: 2, childAges: [3, 12] })).toMatchObject({ extraMinorPerNight: 40_000n })
    })
    it('an extra adult is priced by the extra-adult line, together with children', () => {
      expect(price({ lines, adults: 3, children: 1, childAges: [5], limits: { ...limits, maxOccupancy: 5 } })).toMatchObject({ reasons: [], extraMinorPerNight: 45_000n })
    })
    it('amounts stay exact integers beyond float precision', () => {
      const big = [child(0, 17, 9_007_199_254_740_993n)]
      expect(price({ lines: big, children: 1, childAges: [4] })).toMatchObject({ extraMinorPerNight: 9_007_199_254_740_993n })
    })
    it('a child fills a base place an adult leaves empty: 1 adult + 1 child pays the base rate (ADR 0067, F-03)', () => {
      expect(price({ lines, adults: 1, children: 1, childAges: [5] })).toMatchObject({ reasons: [], extraMinorPerNight: 0n })
      // The oldest child takes the base place; the younger one is charged by their band.
      expect(price({ lines, adults: 1, children: 2, childAges: [4, 13] })).toMatchObject({ reasons: [], extraMinorPerNight: 15_000n })
    })
    it('the party must still fill the base and include an adult', () => {
      expect(price({ lines, adults: 1 }).reasons).toContain('OCCUPANCY_UNSUPPORTED')
      expect(price({ lines, adults: 0, children: 2, childAges: [10, 12] }).reasons).toContain('OCCUPANCY_UNSUPPORTED')
    })
    it('a child no band covers, a missing or wrong number of ages, or a bad age is refused, never priced as free', () => {
      expect(price({ lines: [child(3, 11, 1n)], children: 1, childAges: [1] }).reasons).toEqual(['CHILD_AGE_NOT_COVERED'])
      expect(price({ lines, children: 1, childAges: [] }).reasons).toEqual(['CHILD_AGES_REQUIRED'])
      expect(price({ lines, children: 1 }).reasons).toEqual(['CHILD_AGES_REQUIRED'])
      expect(price({ lines, children: 2, childAges: [4] }).reasons).toEqual(['CHILD_AGES_REQUIRED'])
      expect(price({ lines, children: 1, childAges: [18] }).reasons).toEqual(['CHILD_AGES_REQUIRED'])
      expect(price({ lines, children: 1, childAges: [4.5] }).reasons).toEqual(['CHILD_AGES_REQUIRED'])
    })
    it('overlapping bands fail closed instead of picking one', () => {
      expect(price({ lines: [child(0, 8, 1n), child(5, 11, 2n)], children: 1, childAges: [6] }).reasons).toEqual(['CHILD_PRICE_AMBIGUOUS'])
    })
    it('an extra adult with no extra-adult line is refused', () => {
      expect(price({ lines: [child(0, 17, 0n)], adults: 3 }).reasons).toContain('EXTRA_ADULT_PRICE_MISSING')
    })
    it('mixing NET and SELL lines in one party, or a line in another currency, is refused', () => {
      expect(price({ lines: [child(0, 5, 1n, 'NET'), child(6, 11, 1n, 'SELL')], children: 2, childAges: [2, 8] }).reasons).toEqual(['GUEST_PRICE_BASIS_MIXED'])
      expect(price({ lines: [{ ...child(0, 17, 1n), currency: 'USD' }] }).reasons).toContain('GUEST_PRICE_CURRENCY_MISMATCH')
    })
    it('the party must fit the room', () => {
      expect(price({ lines, children: 3, childAges: [1, 2, 3] }).reasons).toContain('OCCUPANCY_UNSUPPORTED')
      expect(price({ lines, adults: 4, limits }).reasons).toContain('OCCUPANCY_UNSUPPORTED')
    })
    it('a refused party carries no price', () => {
      expect(price({ lines, children: 1, childAges: [] })).toMatchObject({ extraMinorPerNight: 0n })
    })
  })

  describe('validating a plan\'s lines on write', () => {
    const ok = [child(0, 2, 0n), child(3, 11, 15_000n), adult(30_000n)]
    it('accepts a clean set, including a zero amount', () => { expect(validateGuestPriceLines(ok, 'AED')).toEqual([]) })
    it('reports every problem at once', () => {
      const codes = validateGuestPriceLines([
        child(0, 5, 1n), child(5, 8, 1n), { ...child(10, 5, 1n) }, { ...adult(1n), currency: 'USD' }, adult(2n), { kind: 'CHILD', minAge: 0, maxAge: 17, amountMinor: -1n, basis: 'SELL', currency: 'AED' }, { ...child(1, 2, 1n), basis: 'x' as never },
      ], 'AED').map((i) => i.code)
      expect(codes).toEqual(expect.arrayContaining(['GUEST_PRICE_AGE_BANDS_OVERLAP', 'GUEST_PRICE_AGE_BAND_INVALID', 'GUEST_PRICE_CURRENCY_MISMATCH', 'GUEST_PRICE_EXTRA_ADULT_DUPLICATE', 'GUEST_PRICE_AMOUNT_INVALID', 'GUEST_PRICE_BASIS_INVALID']))
    })
    it('rejects an unknown kind and a child band past 17', () => {
      expect(validateGuestPriceLines([{ kind: 'PET', amountMinor: 1n }], 'AED')[0]!.code).toBe('GUEST_PRICE_KIND_INVALID')
      expect(validateGuestPriceLines([child(0, 18, 1n)], 'AED').map((i) => i.code)).toContain('GUEST_PRICE_AGE_BAND_INVALID')
    })
  })

  describe('one child policy: the contract bands govern a plan without its own child lines (ADR 0067, F-03)', () => {
    const bands = [{ minAge: 0, maxAge: 5, supplementMinor: 0n, currency: null }, { minAge: 6, maxAge: 11, supplementMinor: 9_000n, currency: 'AED' }, { minAge: 12, maxAge: 17, supplementMinor: null, currency: null }]
    it('inherits the bands with basis INHERIT and the plan currency when the band names none', () => {
      expect(effectiveGuestLines([adult(30_000n)], bands, 'AED')).toEqual([adult(30_000n), { kind: 'CHILD', minAge: 0, maxAge: 5, amountMinor: 0n, basis: 'INHERIT', currency: 'AED' }, { kind: 'CHILD', minAge: 6, maxAge: 11, amountMinor: 9_000n, basis: 'INHERIT', currency: 'AED' }, { kind: 'CHILD', minAge: 12, maxAge: 17, amountMinor: null, basis: 'INHERIT', currency: 'AED' }])
    })
    it('a plan with its own child lines ignores the contract bands', () => {
      expect(effectiveGuestLines([child(0, 17, 1n)], bands, 'AED')).toEqual([child(0, 17, 1n)])
    })
    it('prices extra children from inherited bands on the rate basis (no basis of its own), and refuses a band with no supplement', () => {
      const lines = effectiveGuestLines([], bands, 'AED')
      expect(price({ lines, children: 2, childAges: [3, 8] })).toMatchObject({ reasons: [], extraMinorPerNight: 9_000n, basis: null })
      expect(price({ lines, children: 1, childAges: [14] }).reasons).toEqual(['CHILD_PRICE_MISSING'])
      // A child in the unpriced band who fills a base place needs no price.
      expect(price({ lines, adults: 1, children: 1, childAges: [14] }).reasons).toEqual([])
    })
    it('a band in another currency is refused, never converted', () => {
      expect(price({ lines: effectiveGuestLines([], [{ minAge: 0, maxAge: 17, supplementMinor: 1n, currency: 'USD' }], 'AED'), children: 1, childAges: [5] }).reasons).toContain('GUEST_PRICE_CURRENCY_MISMATCH')
    })
  })
})
