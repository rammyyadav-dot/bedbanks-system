import { candidateHorizon, expiryReason, hotelToday } from './rate-plan-expiry'

const base = { status: 'ACTIVE', today: '2026-10-12', planValidTo: null as string | null, contractValidTo: '2026-12-31' }

describe('rate plan expiry (ADR 0057, S9)', () => {
  it('a live plan inside its windows does not expire; the last day itself is still on sale', () => {
    expect(expiryReason(base)).toBeNull()
    expect(expiryReason({ ...base, planValidTo: '2026-10-12' })).toBeNull()
    expect(expiryReason({ ...base, contractValidTo: '2026-10-12' })).toBeNull()
  })
  it('expires the day after the sale window ends, and says why', () => {
    expect(expiryReason({ ...base, planValidTo: '2026-10-11' })).toBe('SALE_WINDOW_ENDED')
  })
  it('expires when the contract term has ended, even with no plan window', () => {
    expect(expiryReason({ ...base, contractValidTo: '2026-10-11' })).toBe('CONTRACT_TERM_ENDED')
  })
  it('names the plan window first when both have ended', () => {
    expect(expiryReason({ ...base, planValidTo: '2026-10-01', contractValidTo: '2026-10-05' })).toBe('SALE_WINDOW_ENDED')
  })
  it('only ACTIVE and SUSPENDED plans expire: a draft stays a draft, and expired is final', () => {
    expect(expiryReason({ ...base, status: 'SUSPENDED', planValidTo: '2026-10-01' })).toBe('SALE_WINDOW_ENDED')
    for (const status of ['DRAFT', 'EXPIRED']) expect(expiryReason({ ...base, status, planValidTo: '2026-10-01' })).toBeNull()
  })
  it('uses the hotel calendar: the same instant is a different day in Dubai and Los Angeles', () => {
    const now = new Date('2026-10-12T21:30:00Z')
    expect(hotelToday(now, 'Asia/Dubai')).toBe('2026-10-13')
    expect(hotelToday(now, 'America/Los_Angeles')).toBe('2026-10-12')
  })
  it('an unknown or missing zone gives no day, so nothing is expired on a guess', () => {
    expect(hotelToday(new Date(), 'Mars/Base')).toBeNull()
    expect(hotelToday(new Date(), null)).toBeNull()
    expect(hotelToday(new Date(), '')).toBeNull()
  })
  it('the candidate horizon is one UTC day ahead, which covers every zone', () => {
    expect(candidateHorizon(new Date('2026-10-12T21:30:00Z'))).toBe('2026-10-13')
  })
})
