import { freezeCancellationTerms, readFrozenTerms } from './booking-cancellation-terms'

const now = new Date('2026-10-13T08:00:00.000Z')
const ctx = { bufferDays: 0, stayNights: 3 }
const pct = (daysBeforeCheckin: number, penaltyPercent: number) => ({ daysBeforeCheckin, penaltyPercent, penaltyMinor: null, currency: null })
const fixed = (daysBeforeCheckin: number, penaltyMinor: bigint, currency: string | null = 'AED') => ({ daysBeforeCheckin, penaltyPercent: null, penaltyMinor, currency })

describe('cancellation terms frozen at booking (F13)', () => {
  it('freezes percent and fixed rules with the set and the instant', () => {
    const stored = freezeCancellationTerms([pct(7, 50), fixed(2, 15_000n)], 'AED', 'Flexible', now, ctx)
    expect(stored).toEqual({ rules: [{ daysBeforeCheckin: 7, penaltyPercent: 50 }, { daysBeforeCheckin: 2, penaltyMinor: '15000' }], setName: 'Flexible', frozenAt: now.toISOString(), source: 'CONTRACT_AT_BOOKING', stayNights: 3, bufferDays: 0 })
  })
  it('does not freeze a fixed penalty in another currency, or an ambiguous rule', () => {
    expect(freezeCancellationTerms([fixed(2, 100n, 'USD')], 'AED', null, now, ctx)).toBeNull()
    expect(freezeCancellationTerms([{ daysBeforeCheckin: 2, penaltyPercent: 10, penaltyMinor: 5n, currency: 'AED' }], 'AED', null, now, ctx)).toBeNull()
  })
  it('freezes an empty rule list as an explicit "no rules", not as missing', () => {
    expect(readFrozenTerms(freezeCancellationTerms([], 'AED', null, now, ctx))).toEqual({ kind: 'frozen', rules: [], setName: null, stayNights: 3, noShow: null })
  })
  it('reads back what was frozen, with fixed amounts as bigint', () => {
    const read = readFrozenTerms(freezeCancellationTerms([pct(7, 50), fixed(2, 15_000n)], 'AED', 'Flexible', now, ctx))
    expect(read).toEqual({ kind: 'frozen', setName: 'Flexible', rules: [{ daysBeforeCheckin: 7, penaltyPercent: 50 }, { daysBeforeCheckin: 2, penaltyMinor: 15_000n }], stayNights: 3, noShow: null })
  })
  it('a booking with nothing stored is legacy; unreadable terms are invalid, never free', () => {
    expect(readFrozenTerms(null)).toEqual({ kind: 'none' })
    expect(readFrozenTerms(undefined)).toEqual({ kind: 'none' })
    for (const bad of ['text', [1], {}, { rules: 'x', frozenAt: 'x' }, { rules: [{ daysBeforeCheckin: -1, penaltyPercent: 5 }], frozenAt: 'x' }, { rules: [{ daysBeforeCheckin: 1, penaltyPercent: 101 }], frozenAt: 'x' }, { rules: [{ daysBeforeCheckin: 1 }], frozenAt: 'x' }, { rules: [], frozenAt: 5 }]) expect(readFrozenTerms(bad)).toEqual({ kind: 'invalid' })
  })
  it('manual-entry terms (the earlier shape) read the same way', () => {
    expect(readFrozenTerms({ rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }], frozenAt: '2026-01-01T00:00:00.000Z', source: 'MANUAL_ENTRY' })).toMatchObject({ kind: 'frozen', rules: [{ daysBeforeCheckin: 3, penaltyPercent: 100 }] })
  })
  it('freezes the buyer tiers after the client buffer, a nights penalty and the no-show rule (ADR 0067, F-10)', () => {
    const nights = { daysBeforeCheckin: 3, penaltyPercent: null, penaltyMinor: null, penaltyNights: 1, currency: null }
    const noShow = { kind: 'NO_SHOW', daysBeforeCheckin: 0, penaltyPercent: 100, penaltyMinor: null, currency: null }
    const stored = freezeCancellationTerms([nights, pct(0, 100), noShow], 'AED', null, now, { bufferDays: 2, stayNights: 4 })
    expect(stored).toMatchObject({ rules: [{ daysBeforeCheckin: 5, penaltyNights: 1 }, { daysBeforeCheckin: 2, penaltyPercent: 100 }], noShow: { penaltyPercent: 100 }, bufferDays: 2, stayNights: 4 })
    expect(readFrozenTerms(stored)).toMatchObject({ kind: 'frozen', rules: [{ daysBeforeCheckin: 5, penaltyNights: 1 }, { daysBeforeCheckin: 2, penaltyPercent: 100 }], noShow: { penaltyPercent: 100 }, stayNights: 4 })
    expect(freezeCancellationTerms([noShow, noShow], 'AED', null, now, ctx)).toBeNull()
    expect(readFrozenTerms({ ...stored, noShow: { penaltyNights: 0 } })).toEqual({ kind: 'invalid' })
  })
})
