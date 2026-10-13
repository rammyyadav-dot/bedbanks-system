import { deriveNightly, derivedProblem, validDerivedTerms, withDerivedRates, type DerivablePlan } from './derived-rates'

const d = (day: string) => new Date(`${day}T00:00:00Z`)
const row = (day: string, amountMinor: bigint, basis: string | null = 'NET') => ({ stayDate: d(day), amountMinor, currency: 'AED', amountBasis: basis, occupancy: 2 })
const plan = (over: Partial<DerivablePlan> = {}, parentOver: Partial<NonNullable<DerivablePlan['derivedFrom']>> = {}): DerivablePlan => ({
  id: 'child', occupancy: 2, currency: 'AED', contractId: 'c1', roomType: { hotelId: 'h1' }, derivedFromId: 'parent', derivedMode: 'PERCENT_BP', derivedAdjustment: -1000, dailyRates: [],
  derivedFrom: { id: 'parent', status: 'ACTIVE', occupancy: 2, currency: 'AED', contractId: 'c1', derivedFromId: null, roomType: { hotelId: 'h1' }, dailyRates: [row('2030-06-01', 30_005n), row('2030-06-02', 10_000n)], ...parentOver },
  ...over,
})

describe('derived rates (ADR 0058, S10b)', () => {
  describe('the adjustment is integer arithmetic, half up on the magnitude', () => {
    it('percent: a discount and a supplement round half up', () => {
      expect(deriveNightly(30_005n, 'PERCENT_BP', -1000)).toBe(30_005n - 3_001n) // 3000.5 -> 3001
      expect(deriveNightly(30_005n, 'PERCENT_BP', 1000)).toBe(30_005n + 3_001n)
      expect(deriveNightly(10_000n, 'PERCENT_BP', 0)).toBe(10_000n)
      expect(deriveNightly(1n, 'PERCENT_BP', 5000)).toBe(2n) // 0.5 -> 1
      expect(deriveNightly(1n, 'PERCENT_BP', 4999)).toBe(1n)
    })
    it('fixed: adds or subtracts minor units', () => {
      expect(deriveNightly(10_000n, 'FIXED_MINOR', -2_500)).toBe(7_500n)
      expect(deriveNightly(10_000n, 'FIXED_MINOR', 2_500)).toBe(12_500n)
    })
  })

  it('terms outside the bounds are invalid', () => {
    expect(validDerivedTerms('PERCENT_BP', -9000)).toBe(true)
    expect(validDerivedTerms('PERCENT_BP', -9001)).toBe(false)
    expect(validDerivedTerms('PERCENT_BP', 100_001)).toBe(false)
    expect(validDerivedTerms('FIXED_MINOR', 1_000_000_000_001)).toBe(false)
    expect(validDerivedTerms('PERCENT', 5)).toBe(false)
    expect(validDerivedTerms('FIXED_MINOR', null)).toBe(false)
    expect(validDerivedTerms('PERCENT_BP', 12.5)).toBe(false)
    expect(validDerivedTerms('FIXED_MINOR', 10n)).toBe(false)
  })

  describe('the parent must hold', () => {
    it('a sound parent and terms have no problem', () => { expect(derivedProblem(plan())).toBeNull() })
    it('a plan that is not derived has none', () => { expect(derivedProblem(plan({ derivedFromId: null, derivedFrom: null, derivedMode: null, derivedAdjustment: null }))).toBeNull() })
    it.each([
      ['no parent loaded', plan({ derivedFrom: null }), 'DERIVED_PARENT_MISSING'],
      ['terms missing', plan({ derivedAdjustment: null }), 'DERIVED_TERMS_INVALID'],
      ['its own parent', plan({ derivedFromId: 'child', derivedFrom: plan().derivedFrom && { ...plan().derivedFrom!, id: 'child' } }), 'DERIVED_PARENT_MISSING'],
      ['a parent that is itself derived', plan({}, { derivedFromId: 'grand' }), 'DERIVED_PARENT_IS_DERIVED'],
      ['another contract', plan({}, { contractId: 'c2' }), 'DERIVED_PARENT_MISMATCH'],
      ['another hotel', plan({}, { roomType: { hotelId: 'h2' } }), 'DERIVED_PARENT_MISMATCH'],
      ['another currency', plan({}, { currency: 'USD' }), 'DERIVED_PARENT_MISMATCH'],
      ['another occupancy', plan({}, { occupancy: 3 }), 'DERIVED_PARENT_MISMATCH'],
      ['a parent that is not active', plan({}, { status: 'SUSPENDED' }), 'DERIVED_PARENT_INACTIVE'],
    ] as const)('%s', (_name, input, expected) => { expect(derivedProblem(input)).toBe(expected) })
  })

  describe('the plan the evaluator sees', () => {
    it("takes the parent's rows, adjusted, keeping their basis, currency and dates", () => {
      const out = withDerivedRates(plan())
      expect(out.derivedProblem).toBeNull()
      expect(out.dailyRates.map((r) => [r.stayDate.toISOString().slice(0, 10), r.amountMinor, r.amountBasis, r.currency])).toEqual([['2030-06-01', 27_004n, 'NET', 'AED'], ['2030-06-02', 9_000n, 'NET', 'AED']])
    })
    it("uses only the parent's rows of the plan's own occupancy", () => {
      const out = withDerivedRates(plan({}, { dailyRates: [row('2030-06-01', 10_000n), { ...row('2030-06-01', 99_999n), occupancy: 3 }] }))
      expect(out.dailyRates.map((r) => r.amountMinor)).toEqual([9_000n])
    })
    it('a night adjusted to zero or below is a zero rate, never a negative or free sale', () => {
      const out = withDerivedRates(plan({ derivedMode: 'FIXED_MINOR', derivedAdjustment: -10_000 }))
      expect(out.dailyRates.map((r) => r.amountMinor)).toEqual([20_005n, 0n])
    })
    it('a problem leaves no rates and names why', () => {
      const out = withDerivedRates(plan({}, { status: 'EXPIRED' }))
      expect(out).toMatchObject({ derivedProblem: 'DERIVED_PARENT_INACTIVE', dailyRates: [] })
    })
    it('a plan that is not derived keeps its own rates untouched', () => {
      const own = [row('2030-06-01', 5_000n)]
      const out = withDerivedRates(plan({ derivedFromId: null, derivedFrom: null, derivedMode: null, derivedAdjustment: null, dailyRates: own }))
      expect(out).toMatchObject({ derivedProblem: null, dailyRates: own })
    })
  })
})
