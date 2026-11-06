import { bookingEnabled, bookingServicingEnabled } from './booking-transaction.service'
import { bookingTransactionConfigured } from './booking-transaction.database'

describe('booking enable flags (ADR 0101)', () => {
  it('opens new sales only for the exact string true', () => {
    for (const value of [undefined, 'false', '', 'TRUE', '1']) expect(bookingEnabled({ BOOKING_ENABLED: value })).toBe(false)
    expect(bookingEnabled({ BOOKING_ENABLED: 'true' })).toBe(true)
  })
  it('serves existing bookings when sales are open, or when servicing alone is switched on', () => {
    expect(bookingServicingEnabled({})).toBe(false)
    expect(bookingServicingEnabled({ BOOKING_SERVICING_ENABLED: 'yes' })).toBe(false)
    expect(bookingServicingEnabled({ BOOKING_ENABLED: 'true' })).toBe(true)
    expect(bookingServicingEnabled({ BOOKING_SERVICING_ENABLED: 'true' })).toBe(true)
  })
  it('never opens new sales through the servicing switch', () => {
    expect(bookingEnabled({ BOOKING_SERVICING_ENABLED: 'true' })).toBe(false)
  })
  it('treats BOOKING_ENABLED as unrelated to the mutation credential', () => {
    expect(bookingTransactionConfigured({ BOOKING_ENABLED: 'true' })).toBe(false)
    expect(bookingTransactionConfigured({
      DATABASE_URL: 'postgresql://fbeds_api_login:secret@localhost/app',
      BOOKING_TRANSACTION_DATABASE_URL: 'postgresql://fbeds_api_login:secret@localhost/app',
    })).toBe(false)
    expect(bookingTransactionConfigured({
      DATABASE_URL: 'postgresql://fbeds_api_login:secret@localhost/app',
      BOOKING_TRANSACTION_DATABASE_URL: 'postgresql://fbeds_booktx_ops:secret@localhost/app',
    })).toBe(true)
  })
})
