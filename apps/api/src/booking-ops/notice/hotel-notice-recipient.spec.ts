import { MAX_NOTICE_COPIES, normalizeCopyAddresses, resolveHotelNoticeRecipient } from './hotel-notice-recipient'

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

describe('normalizeCopyAddresses', () => {
  it('keeps valid, distinct addresses in order, trimmed', () => {
    expect(normalizeCopyAddresses([' agent@agency.test ', 'admin@fbeds.test'], 'res@hotel.test')).toEqual(['agent@agency.test', 'admin@fbeds.test'])
  })
  it('drops duplicates (case-insensitive), the hotel address, blanks and anything that is not one valid address', () => {
    expect(normalizeCopyAddresses(['Agent@Agency.test', 'agent@agency.test', 'RES@hotel.test', '', null, undefined, 'a@b', 'x@y.com, z@y.com', 'ok@ok.test'], 'res@hotel.test')).toEqual(['Agent@Agency.test', 'ok@ok.test'])
  })
  it('never keeps more than the cap, and works with no hotel address', () => {
    const many = Array.from({ length: 6 }, (_, i) => `u${i}@x.test`)
    expect(normalizeCopyAddresses(many, null)).toHaveLength(MAX_NOTICE_COPIES)
    expect(normalizeCopyAddresses([], null)).toEqual([])
  })
})
