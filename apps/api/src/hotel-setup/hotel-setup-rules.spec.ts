import { assessCompleteness, isIanaTimeZone, normaliseSave, regressions, type CurrentSetup } from './hotel-setup-rules'

const complete = (): CurrentSetup => ({
  name: 'Palm View', propertyType: 'HOTEL', countryCode: 'AE', city: 'Dubai', address: '1 Palm Road', latitude: '25.1', longitude: '55.2', timeZone: 'Asia/Dubai',
  starRating: 4, starVerified: true, shortDescription: 'A quiet hotel.', checkInTime: '14:00', checkOutTime: '12:00', contacts: { reservations: { name: 'Front desk', email: 'res@hotel.test' } }, activeRooms: 2,
})

describe('assessCompleteness', () => {
  it('is publishable only when every requirement is met', () => {
    const c = assessCompleteness(complete())
    expect(c.publishable).toBe(true); expect(c.percent).toBe(100); expect(c.met).toBe(c.total)
  })

  it.each([
    ['NAME', { name: '  ' }], ['ADDRESS', { address: null }], ['COORDINATES', { latitude: null }], ['SHORT_DESCRIPTION', { shortDescription: null }], ['ACTIVE_ROOM', { activeRooms: 0 }],
    ['CHECK_IN_OUT', { checkOutTime: null }], ['TIME_ZONE', { timeZone: 'Mars/Base' }], ['COUNTRY', { countryCode: 'UAE' }],
    ['STAR_CATEGORY', { starVerified: false }], ['STAR_CATEGORY', { starRating: null }], ['RESERVATIONS_CONTACT', { contacts: { reservations: { name: 'x' } } }], ['RESERVATIONS_CONTACT', { contacts: {} }],
  ] as Array<[string, Partial<CurrentSetup>]>)('names %s when it is missing', (key, patch) => {
    const c = assessCompleteness({ ...complete(), ...patch })
    expect(c.publishable).toBe(false)
    const r = c.requirements.find((x) => x.key === key)!
    expect(r.met).toBe(false); expect(r.detail).not.toBe('Met.')
  })

  it('never reports an empty draft as publishable and gives a percentage from explicit requirements', () => {
    const c = assessCompleteness({ ...complete(), name: '', propertyType: '', city: '', countryCode: '', address: null, latitude: null, longitude: null, starRating: null, starVerified: false, shortDescription: null, checkInTime: null, checkOutTime: null, contacts: {}, activeRooms: 0 })
    expect(c.publishable).toBe(false); expect(c.percent).toBeLessThan(20)
  })
})

describe('regressions', () => {
  it('lists only requirements that were met and no longer are', () => {
    const before = assessCompleteness({ ...complete(), shortDescription: null })
    const after = assessCompleteness({ ...complete(), shortDescription: null, address: null })
    expect(regressions(before, after).map((r) => r.key)).toEqual(['ADDRESS'])
  })
})

describe('normaliseSave', () => {
  it('rejects unknown fields and never echoes values into messages', () => {
    const { errors } = normaliseSave({ idempotencyKey: 'k', expectedToken: 't', tenantId: 'other', secret: 'hunter2' } as never)
    expect(errors).toEqual(expect.arrayContaining(['tenantId: is not a supported field', 'secret: is not a supported field']))
    expect(errors.join(' ')).not.toContain('hunter2')
  })

  it('normalises text, uppercases country, accepts clearing with null and reports changed field names', () => {
    const { data, errors } = normaliseSave({ name: '  Palm View ', countryCode: 'ae', address: null, area: 'Palm Jumeirah', languages: ['en', 'ar'], checkInTime: '14:00' })
    expect(errors).toEqual([])
    expect(data.hotel).toEqual({ name: 'Palm View', countryCode: 'AE', address: null })
    expect(data.profile).toMatchObject({ area: 'Palm Jumeirah', languages: ['en', 'ar'], checkInTime: '14:00' })
    expect(data.changed.sort()).toEqual(['address', 'area', 'checkInTime', 'countryCode', 'languages', 'name'])
  })

  it.each([
    [{ name: '' }, 'name: is required'], [{ propertyType: 'hotel' }, 'propertyType'], [{ countryCode: 'UAE' }, 'countryCode'], [{ timeZone: 'asia/dubai' }, 'timeZone'],
    [{ latitude: '91' }, 'latitude'], [{ longitude: '181.0' }, 'longitude'], [{ latitude: '1.1234567' }, 'latitude'], [{ starRating: 6 }, 'starRating'], [{ starRating: 3.5 }, 'starRating'],
    [{ checkInTime: '25:00' }, 'checkInTime'], [{ checkOutTime: '9:00' }, 'checkOutTime'], [{ languages: ['EN'] }, 'languages'], [{ languages: ['en', 'en'] }, 'languages'],
    [{ shortDescription: 'x'.repeat(501) }, 'shortDescription'], [{ postalCode: 'x'.repeat(21) }, 'postalCode'],
    [{ contacts: { sales: { name: 'x' } } }, 'contacts.sales'], [{ contacts: { reservations: { email: 'not-an-email' } } }, 'contacts.reservations.email'], [{ contacts: { reservations: { phone: 'abc' } } }, 'contacts.reservations.phone'],
    [{ contacts: { reservations: { nickname: 'x' } } }, 'contacts.reservations.nickname'], [{ policies: { smoking: 'x' } }, 'policies.smoking'], [{ policies: { pets: 'x'.repeat(1001) } }, 'policies.pets'],
    [{ externalIdentifiers: [{ scheme: 'giata!', value: '1' }] }, 'externalIdentifiers[0].scheme'], [{ externalIdentifiers: [{ scheme: 'GIATA', value: ' ' }] }, 'externalIdentifiers[0].value'],
    [{ externalIdentifiers: [{ scheme: 'GIATA', value: '1' }, { scheme: 'giata', value: '2' }] }, 'externalIdentifiers[1].scheme'],
  ] as Array<[Record<string, unknown>, string]>)('rejects invalid input %j', (patch, fragment) => {
    const { errors } = normaliseSave(patch as never)
    expect(errors.some((e) => e.includes(fragment))).toBe(true)
  })

  it('accepts a valid contacts, policies and identifier set', () => {
    const { data, errors } = normaliseSave({
      contacts: { reservations: { name: 'Front desk', email: 'res@hotel.test', phone: '+971 4 123 4567' }, finance: null as never },
      policies: { children: 'Children under 12 stay free in existing bedding.', pets: '' },
      externalIdentifiers: [{ scheme: 'giata', value: ' 12345 ' }],
    })
    expect(errors).toEqual([])
    expect(data.profile.contacts).toEqual({ reservations: { name: 'Front desk', email: 'res@hotel.test', phone: '+971 4 123 4567' } })
    expect(data.profile.policies).toEqual({ children: 'Children under 12 stay free in existing bedding.' })
    expect(data.externalIdentifiers).toEqual([{ scheme: 'GIATA', value: '12345' }])
  })

  it('does not accept contractual cancellation terms as a hotel policy', () => {
    expect(normaliseSave({ policies: { cancellation: 'Free until 48h' } } as never).errors.join(' ')).toContain('policies.cancellation')
  })
})

describe('isIanaTimeZone', () => {
  it('accepts real zones with exact case and rejects others', () => {
    expect(isIanaTimeZone('Asia/Dubai')).toBe(true); expect(isIanaTimeZone('UTC')).toBe(true)
    expect(isIanaTimeZone('asia/dubai')).toBe(false); expect(isIanaTimeZone('Dubai')).toBe(false); expect(isIanaTimeZone('')).toBe(false)
  })
})
