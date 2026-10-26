import { calculateCommission, commissionAmountMinor, resolveCommissionTier, type CommissionTierRule } from './commission-tier'

describe('resolveCommissionTier', () => {
  it('resolves the bronze tier at zero volume', () => {
    expect(resolveCommissionTier(0n)).toEqual({ tier: 'BRONZE', commissionBp: 200 })
  })
  it('resolves the highest tier the volume clears, never a tier above it', () => {
    expect(resolveCommissionTier(4_999_999n)).toEqual({ tier: 'BRONZE', commissionBp: 200 })
    expect(resolveCommissionTier(5_000_000n)).toEqual({ tier: 'SILVER', commissionBp: 300 })
    expect(resolveCommissionTier(24_999_999n)).toEqual({ tier: 'SILVER', commissionBp: 300 })
    expect(resolveCommissionTier(25_000_000n)).toEqual({ tier: 'GOLD', commissionBp: 400 })
    expect(resolveCommissionTier(99_999_999n)).toEqual({ tier: 'GOLD', commissionBp: 400 })
    expect(resolveCommissionTier(100_000_000n)).toEqual({ tier: 'ENTERPRISE', commissionBp: 500 })
    expect(resolveCommissionTier(1_000_000_000_000n)).toEqual({ tier: 'ENTERPRISE', commissionBp: 500 })
  })
  it('refuses negative volume', () => {
    expect(() => resolveCommissionTier(-1n)).toThrow('must not be negative')
  })
  it('refuses a table that does not start at zero', () => {
    const rules: CommissionTierRule[] = [{ tier: 'BRONZE', minGrossBookedMinor: 1n, commissionBp: 200 }]
    expect(() => resolveCommissionTier(0n, rules)).toThrow('start at a zero threshold')
  })
  it('refuses a table that is not strictly ascending', () => {
    const rules: CommissionTierRule[] = [{ tier: 'BRONZE', minGrossBookedMinor: 0n, commissionBp: 200 }, { tier: 'SILVER', minGrossBookedMinor: 0n, commissionBp: 300 }]
    expect(() => resolveCommissionTier(0n, rules)).toThrow('strictly ascending')
  })
})

describe('commissionAmountMinor', () => {
  it('floors the proportional amount, never using floating point', () => {
    expect(commissionAmountMinor(10_033n, 250)).toBe(250n) // 10033 * 250 / 10000 = 250.825 -> 250
    expect(commissionAmountMinor(0n, 500)).toBe(0n)
    expect(commissionAmountMinor(100n, 10_000)).toBe(100n)
  })
  it('keeps an 18-digit volume exact', () => {
    expect(commissionAmountMinor(999_999_999_999_999_999n, 1)).toBe(99_999_999_999_999n)
  })
  it('refuses an out-of-range or fractional basis-point rate', () => {
    expect(() => commissionAmountMinor(100n, -1)).toThrow('0 to 10000')
    expect(() => commissionAmountMinor(100n, 10_001)).toThrow('0 to 10000')
    expect(() => commissionAmountMinor(100n, 2.5)).toThrow('whole number')
  })
  it('refuses negative volume', () => {
    expect(() => commissionAmountMinor(-1n, 100)).toThrow('must not be negative')
  })
})

describe('calculateCommission', () => {
  it('resolves the tier and computes the amount together', () => {
    expect(calculateCommission(5_000_000n)).toEqual({ tier: 'SILVER', commissionBp: 300, amountMinor: 150_000n })
  })
})
