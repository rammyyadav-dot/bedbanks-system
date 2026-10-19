import { changeBp, isLargePriceChange, largeChangeWarning } from './price-guardrails'

describe('price-change guardrail (ADR 0067, F-13)', () => {
  it('flags a move of more than 50% of the stored rate, up or down', () => {
    expect(isLargePriceChange(45_000n, 4_500n)).toBe(true) // 450 typed as 45
    expect(isLargePriceChange(45_000n, 450_000n)).toBe(true) // 450 typed as 4500
    expect(isLargePriceChange(45_000n, 67_500n)).toBe(false) // exactly +50% is allowed
    expect(isLargePriceChange(45_000n, 67_501n)).toBe(true)
    expect(isLargePriceChange(45_000n, 22_500n)).toBe(false)
  })
  it('a first price is not a change', () => { expect(isLargePriceChange(null, 1n)).toBe(false) })
  it('states the move for the operator', () => {
    expect(changeBp(45_000n, 4_500n)).toBe(-9000)
    expect(largeChangeWarning(45_000n, 450_000n)).toBe('the price moves +900% (more than 50%): confirm large changes to apply')
  })
})
