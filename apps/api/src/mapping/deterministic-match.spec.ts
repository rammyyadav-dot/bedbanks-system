import { deterministicHotelMatch } from './deterministic-match'

const grand = { hotelId: 'h_grand', name: 'Grand Hyatt Dubai', city: 'Dubai', countryCode: 'AE', postalCode: '12345', latitude: 25.2285, longitude: 55.3273, phone: '+971 4 317 1234', registryCode: 'DED-100200' }
const other = { hotelId: 'h_other', name: 'Park Hyatt Dubai', city: 'Dubai', countryCode: 'AE', postalCode: '54321', latitude: 25.2285, longitude: 55.3325, phone: '+971 4 602 1234', registryCode: 'DED-300400' }
const catalog = [grand, other]
const supplier = { supplierHotelId: 'DXB-GH-99', name: 'Grand Hyatt Hotel Dubai UAE', city: 'Dubai', countryCode: 'AE' }

describe('deterministicHotelMatch', () => {
  it('matches on an exact registry code even when the name differs in wording', () => {
    expect(deterministicHotelMatch({ ...supplier, registryCode: 'ded 100200' }, catalog)).toMatchObject({ status: 'MATCH', canonicalHotelId: 'h_grand', rule: 'registry_code' })
  })

  it('refuses a registry match whose name contradicts it (keying error), and flags a conflict', () => {
    const result = deterministicHotelMatch({ ...supplier, name: 'Seaside Hostel', registryCode: 'DED-100200' }, catalog)
    expect(result).toMatchObject({ status: 'CONFLICT', candidateIds: ['h_grand'] })
  })

  it('matches on an exact international phone when the name agrees', () => {
    expect(deterministicHotelMatch({ ...supplier, phone: '00971-4-3171234' }, catalog)).toMatchObject({ status: 'MATCH', canonicalHotelId: 'h_grand', rule: 'phone' })
  })

  it('does not match on phone alone when the name is unrelated (shared switchboard)', () => {
    expect(deterministicHotelMatch({ supplierHotelId: 'x', name: 'Zebra Lodge', countryCode: 'AE', phone: '+971 4 317 1234' }, catalog)).toEqual({ status: 'NONE' })
  })

  it('does not trust a national-form phone', () => {
    expect(deterministicHotelMatch({ ...supplier, phone: '04 317 1234' }, catalog)).toEqual({ status: 'NONE' })
  })

  it('matches on postal code plus 100 m plus compatible name', () => {
    const near = { ...supplier, postalCode: '12 345', latitude: 25.2286, longitude: 55.3274 }
    expect(deterministicHotelMatch(near, catalog)).toMatchObject({ status: 'MATCH', canonicalHotelId: 'h_grand', rule: 'geo_postal' })
  })

  it('does not match on postal code when the property is farther than 100 m', () => {
    const far = { ...supplier, postalCode: '12345', latitude: 25.24, longitude: 55.34 }
    expect(deterministicHotelMatch(far, catalog)).toEqual({ status: 'NONE' })
  })

  it('is ambiguous when two canonical hotels satisfy a strong rule', () => {
    const twin = { ...grand, hotelId: 'h_grand_dup' }
    expect(deterministicHotelMatch({ ...supplier, phone: '+971 4 317 1234' }, [grand, twin])).toMatchObject({ status: 'AMBIGUOUS' })
  })

  it('never matches across countries', () => {
    expect(deterministicHotelMatch({ ...supplier, countryCode: 'GB', registryCode: 'DED-100200' }, catalog)).toEqual({ status: 'NONE' })
  })
})
