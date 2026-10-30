import { assertHotelNotice } from '@bedbanks/connectors-core'
import { buildHotelNotice, type HotelNoticeBookingFacts } from './hotel-notice-facts'

const facts = (extra: Partial<HotelNoticeBookingFacts> = {}): HotelNoticeBookingFacts => ({
  reference: 'FB-0123456789ABCDEF0123', hotelId: 'hotel_1', createdAt: new Date('2026-10-30T08:00:00Z'), checkIn: new Date('2026-12-01T00:00:00Z'), checkOut: new Date('2026-12-04T00:00:00Z'), hotelConfirmationNo: null,
  specialRequests: { codes: ['HIGH_FLOOR', 'LATE_ARRIVAL'], note: ' Quiet room ', arrivalTime: '15:30' },
  rooms: [{ position: 2, roomName: 'Deluxe King', boardCode: 'BB', adults: 1, childAges: [] }, { position: 1, roomName: 'Deluxe King', boardCode: 'BB', adults: 2, childAges: [7] }],
  guests: [{ firstName: ' Amal ', lastName: 'Haddad', isLead: true }], ...extra,
})

describe('buildHotelNotice', () => {
  it('maps a booking to a valid notice: rooms by position, readable requests, trimmed names, ISO days', () => {
    const n = buildHotelNotice('NEW', facts())
    expect(() => assertHotelNotice(n)).not.toThrow()
    expect(n).toMatchObject({ kind: 'NEW', checkIn: '2026-12-01', checkOut: '2026-12-04', arrivalTime: '15:30', specialRequests: ['high floor', 'late arrival', 'Quiet room'], hotelCode: 'hotel_1' })
    expect(n.rooms).toEqual([{ adults: 2, childAges: [7] }, { adults: 1, childAges: [] }])
    expect(n.guests[0].firstName).toBe('Amal')
  })
  it('tolerates missing or malformed special requests and drops an invalid arrival time', () => {
    for (const specialRequests of [null, undefined, 'x', [], { codes: 'no' }, { codes: [1, ''], note: 5 }]) expect(buildHotelNotice('NEW', facts({ specialRequests })).specialRequests).toEqual([])
    expect(buildHotelNotice('NEW', facts({ specialRequests: { arrivalTime: '25:00' } })).arrivalTime).toBeNull()
  })
  it('produces an invalid notice (rejected by the renderer) rather than inventing data when dates or guests are missing', () => {
    expect(() => assertHotelNotice(buildHotelNotice('NEW', facts({ checkIn: null })))).toThrow()
    expect(() => assertHotelNotice(buildHotelNotice('NEW', facts({ guests: [] })))).toThrow()
  })
})
