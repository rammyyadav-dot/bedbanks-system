import { holdFingerprint, stayDates } from './inventory-hold.service'

const input = { offerId: 'offer-a', searchId: 'search-a', ratePlanId: 'plan-a', canonicalHotelId: 'hotel-a',
  canonicalRoomTypeId: 'room-a', boardBasisId: 'board-a', checkIn: '2026-10-01', checkOut: '2026-10-04',
  rooms: 1, currency: 'AED', sellAmountMinor: 125099, offerExpiresAt: '2099-01-01T00:00:00Z', idempotencyKey: 'request-123' }

describe('inventory hold contract helpers', () => {
  it('creates every service night in deterministic order', () => {
    expect(stayDates(input.checkIn, input.checkOut).map(value => value.toISOString().slice(0, 10))).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
  })
  it('creates a stable payload fingerprint and detects commercial changes', () => {
    expect(holdFingerprint(input)).toHaveLength(64)
    expect(holdFingerprint({ ...input })).toBe(holdFingerprint(input))
    expect(holdFingerprint({ ...input, sellAmountMinor: input.sellAmountMinor + 1 })).not.toBe(holdFingerprint(input))
  })
  it('rejects invalid and excessive stay ranges', () => {
    expect(() => stayDates('2026-10-04', '2026-10-01')).toThrow('Invalid stay dates')
    expect(() => stayDates('2026-10-01', '2026-12-01')).toThrow('Invalid stay length')
  })
})
