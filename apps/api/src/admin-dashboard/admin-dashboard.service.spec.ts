import { isBookingReadDenied } from './admin-dashboard.service'

describe('isBookingReadDenied', () => {
  it('recognizes a Postgres privilege failure', () => {
    expect(isBookingReadDenied({ meta: { code: '42501' } })).toBe(true)
    expect(isBookingReadDenied(new Error('permission denied for table Booking'))).toBe(true)
  })

  it('does not hide unrelated failures', () => {
    expect(isBookingReadDenied(new Error('connection terminated'))).toBe(false)
    expect(isBookingReadDenied(null)).toBe(false)
  })
})