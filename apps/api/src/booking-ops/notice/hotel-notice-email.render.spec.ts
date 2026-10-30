import type { HotelReservationNotice } from '@bedbanks/connectors-core'
import { HOTEL_NOTICE_LOCALES, isHotelNoticeLocale, renderHotelNoticeEmail } from './hotel-notice-email.render'

const notice = (extra: Partial<HotelReservationNotice> = {}): HotelReservationNotice => ({
  kind: 'NEW', reference: 'FB-0123456789ABCDEF0123', hotelCode: 'DXB-1', createdAt: '2026-10-30T08:00:00.000Z', checkIn: '2026-12-01', checkOut: '2026-12-04', roomName: 'Deluxe King', boardCode: 'BB',
  rooms: [{ adults: 2, childAges: [7] }], guests: [{ firstName: 'Amal', lastName: 'Haddad', isLead: true }], hotelConfirmationNo: null, specialRequests: ['High floor'], arrivalTime: '15:30', ...extra,
})

describe('renderHotelNoticeEmail', () => {
  it.each(HOTEL_NOTICE_LOCALES)('renders every kind in %s with the reference, dates and guests, and no price', (locale) => {
    for (const kind of ['NEW', 'AMEND', 'CANCEL'] as const) {
      const out = renderHotelNoticeEmail(notice({ kind }), 'Atlas Hotel', locale)
      expect(out.subject).toContain('FB-0123456789ABCDEF0123')
      expect(out.subject).toContain('2026-12-01')
      expect(out.subject).not.toContain('Haddad') // guest names stay out of the subject
      expect(out.text).toContain('Amal Haddad')
      expect(out.html).toContain(`lang="${locale}"`)
      expect(`${out.text}${out.html}`).not.toMatch(/AED|USD|price|total/i)
    }
  })

  it('sets right-to-left for Arabic only, and recognises supported locales', () => {
    expect(renderHotelNoticeEmail(notice(), 'Atlas', 'ar').html).toContain('dir="rtl"')
    expect(renderHotelNoticeEmail(notice(), 'Atlas', 'fr').html).toContain('dir="ltr"')
    expect(isHotelNoticeLocale('ar')).toBe(true)
    expect(isHotelNoticeLocale('xx')).toBe(false)
  })

  it('escapes hostile text and refuses an invalid notice', () => {
    const out = renderHotelNoticeEmail(notice({ specialRequests: ['<img src=x onerror=alert(1)>'] }), '<b>Hotel</b>', 'en')
    expect(out.html).not.toContain('<img')
    expect(out.html).not.toContain('<b>Hotel')
    expect(() => renderHotelNoticeEmail(notice({ guests: [] }), 'Atlas', 'en')).toThrow('Invalid hotel notice field')
  })
})
