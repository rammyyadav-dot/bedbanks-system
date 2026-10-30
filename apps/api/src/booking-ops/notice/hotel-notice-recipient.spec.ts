import { resolveHotelNoticeRecipient } from './hotel-notice-recipient'

const ok = (address: string) => ({ ok: true, address })
const none = { ok: false, code: 'NO_RESERVATIONS_EMAIL' }

describe('resolveHotelNoticeRecipient', () => {
  it('uses the reservations email from the hotel profile, trimmed', () => {
    expect(resolveHotelNoticeRecipient({ reservations: { name: 'Front desk', email: '  res@atlas-hotel.ae ' } })).toEqual(ok('res@atlas-hotel.ae'))
  })

  it('never falls back to another contact when reservations has no email', () => {
    const others = { commercial: { email: 'sales@h.ae' }, finance: { email: 'fin@h.ae' }, emergency: { email: 'sos@h.ae' } }
    expect(resolveHotelNoticeRecipient({ ...others, reservations: { name: 'Desk', phone: '+97141234567' } })).toEqual(none)
    expect(resolveHotelNoticeRecipient(others)).toEqual(none)
  })

  it.each([null, undefined, 'x', 42, [], {}, { reservations: null }, { reservations: [] }, { reservations: { email: 5 } }, { reservations: { email: '' } }])('fails closed on %j', (contacts) => {
    expect(resolveHotelNoticeRecipient(contacts)).toEqual(none)
  })

  it.each(['a@b', 'a@@b.com', 'a b@c.com', 'a@b.com, c@d.com', 'a@b.com;c@d.com', 'Name <a@b.com>', 'a@b.com\r\nBcc: x@y.com', '<a@b.com>', 'a@-b.com', `${'a'.repeat(65)}@b.com`, `a@${'b'.repeat(250)}.com`])('rejects %j: not exactly one valid address', (email) => {
    expect(resolveHotelNoticeRecipient({ reservations: { email } })).toEqual(none)
  })
})
