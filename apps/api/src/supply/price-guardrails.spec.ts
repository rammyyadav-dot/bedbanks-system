import { changeBp, guestPriceLargeChanges, isLargePriceChange, largeChangeWarning } from './price-guardrails'

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
  it('flags a stored guest-price band and ignores a new band or a zero base', () => {
    const before = [{ kind: 'CHILD', minAge: 0, maxAge: 11, amountMinor: 15_000n }, { kind: 'CHILD', minAge: 12, maxAge: 17, amountMinor: 0n }]
    const moves = guestPriceLargeChanges(before, [
      { kind: 'CHILD', minAge: 0, maxAge: 11, amountMinor: 1_500n },
      { kind: 'CHILD', minAge: 12, maxAge: 17, amountMinor: 9_000n },
      { kind: 'EXTRA_ADULT', minAge: 18, maxAge: 99, amountMinor: 1n },
    ])
    expect(moves.map((move) => [move.kind, move.minAge, move.fromMinor, move.amountMinor])).toEqual([['CHILD', 0, 15_000n, 1_500n]])
    expect(guestPriceLargeChanges(before, [{ kind: 'CHILD', minAge: 0, maxAge: 11, amountMinor: 7_500n }])).toEqual([])
  })
})
