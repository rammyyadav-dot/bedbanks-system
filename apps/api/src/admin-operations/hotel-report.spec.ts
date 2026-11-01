import { buildHotelReport, hotelReportCsv, type ReportBooking } from './hotel-report'
const query = { from: '2026-10-10', to: '2026-10-11', dateBasis: 'stay' as const }
const now = new Date('2026-10-13T00:00:00Z')
const booking = (patch: Partial<ReportBooking> = {}): ReportBooking => ({ status: 'CONFIRMED', currency: 'AED', totalMinor: 10000n, netMinor: 8000n, checkIn: new Date('2026-10-09'), checkOut: new Date('2026-10-13'), rooms: [{ quantity: 2 }, { quantity: 1 }], _count: { guests: 4 }, financeEvents: [], ...patch })
describe('hotel booking report evidence', () => {
  it('counts stay overlap × all rooms, but keeps full frozen booking money', () => {
    const r = buildHotelReport('hotel-a', query, [booking()], true, true, now)
    expect(r.roomNights).toBe(6)
    expect(r.currencies[0]).toMatchObject({ grossMinor: '10000', netMinor: '8000', marginMinor: '2000', reportingCurrency: 'AED', conversionBasis: 'IDENTITY' })
    expect(r.nationality).toEqual([{ nationality: 'Unknown', guests: 4 }]); expect(r.definitions.dates).toContain('full booking value')
  })
  it('counts full stay for booking basis and excludes failed/pending bookings from gross', () => {
    const r = buildHotelReport('hotel-a', { ...query, dateBasis: 'booking' }, [booking(), booking({ status: 'FAILED' }), booking({ status: 'PENDING_SUPPLIER' })], true, true, now)
    expect(r.roomNights).toBe(12); expect(r.currencies[0].grossMinor).toBe('10000'); expect(r.totalReservations).toBe(3)
  })
  it('keeps currencies separate and exact beyond safe integers', () => {
    const huge = 90071992547409931n
    const r = buildHotelReport('hotel-a', query, [booking({ totalMinor: huge, netMinor: huge - 1n }), booking({ totalMinor: huge, netMinor: huge - 2n }), booking({ currency: 'USD' })], true, false, now)
    expect(r.currencies.map(c => c.currency)).toEqual(['AED', 'USD']); expect(r.currencies[0].grossMinor).toBe((huge * 2n).toString()); expect(r.currencies[0].marginMinor).toBe('3')
  })
  it('does not turn missing cost, rooms or cancellation evidence into zero', () => {
    const r = buildHotelReport('hotel-a', query, [booking({ netMinor: null, rooms: [] }), booking({ status: 'CANCELLED' })], true, true, now)
    expect(r.unknownRoomNightReservations).toBe(1)
    expect(r.currencies[0]).toMatchObject({ netMinor: null, marginMinor: null, cancelledGrossMinor: '10000', refundMinor: null, penaltyMinor: null, taxesMinor: null })
  })
  it('uses final cancellation evidence and never discloses hidden net/finance', () => {
    const cancelled = booking({ status: 'CANCELLED', financeEvents: [{ type: 'CANCELLED', currency: 'AED', refundMinor: 5000n, penaltyMinor: 5000n }, { type: 'CANCELLED', currency: 'AED', refundMinor: 8000n, penaltyMinor: 2000n }] })
    expect(buildHotelReport('hotel-a', query, [cancelled], true, true, now).currencies[0]).toMatchObject({ grossMinor: '0', refundMinor: '8000', penaltyMinor: '2000' })
    const hidden = buildHotelReport('hotel-a', query, [booking(), cancelled], false, false, now)
    expect(hidden.currencies[0]).toMatchObject({ netMinor: null, marginMinor: null, refundMinor: null, penaltyMinor: null }); expect(hotelReportCsv(hidden)).not.toContain('8000')
  })
  it('exports definitions and formula-safe quoted CSV', () => {
    const csv = hotelReportCsv(buildHotelReport('hotel-a', { ...query, supplier: '=EVIL("x")' }, [booking()], false, false, now))
    expect(csv).toContain('hotel-a'); expect(csv).toContain('Unknown'); expect(csv).toContain('Unavailable'); expect(csv).toContain("'=EVIL"); expect(csv).toContain('""x""')
  })
})
