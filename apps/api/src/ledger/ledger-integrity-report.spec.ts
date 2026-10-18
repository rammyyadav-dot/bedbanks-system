import { bookingFacts } from './ledger-integrity-report'

const now = new Date('2026-10-13T12:00:00Z')
const g = (type: 'HOLD' | 'RELEASE' | 'DEBIT' | 'REFUND', sumMinor: bigint, entries = 1, oldestAt: Date | null = null, currency = 'AED') => ({ bookingRef: 'booking:b1', currency, type, sumMinor, entries, oldestAt })

describe('bookingFacts', () => {
  it('turns stored signed sums into magnitudes: HOLD and DEBIT are stored negative', () => {
    const f = bookingFacts([g('HOLD', -1000n), g('RELEASE', 1000n), g('DEBIT', -1000n), g('REFUND', 250n)], now)
    expect(f).toMatchObject({ holdMinor: 1000n, releaseMinor: 1000n, debitMinor: 1000n, refundMinor: 250n, holdCount: 1, debitCount: 1, refundCount: 1, currencies: ['AED'] })
  })

  it('counts duplicates and lists every currency once', () => {
    const f = bookingFacts([g('HOLD', -2000n, 2), g('HOLD', -500n, 1, null, 'USD')], now)
    expect(f.holdCount).toBe(3)
    expect(f.currencies).toEqual(['AED', 'USD'])
  })

  it('ages the hold in whole hours', () => {
    expect(bookingFacts([g('HOLD', -1n, 1, new Date('2026-10-12T11:30:00Z'))], now).oldestHoldAgeHours).toBe(24)
    expect(bookingFacts([g('RELEASE', 1n)], now).oldestHoldAgeHours).toBeNull()
  })
})
