import { comparePhones, normalizeAmenities, normalizeBoardBasis, normalizePhone, normalizePostalCode, normalizeRegistryCode } from './attributes'

describe('normalizeBoardBasis', () => {
  it.each([
    ['BB', 'BB'], ['Bed and Breakfast', 'BB'], ['Bed & Breakfast', 'BB'], ['bed-and-breakfast', 'BB'], ['Breakfast included', 'BB'],
    ['Half Board', 'HB'], ['Demi-Pension', 'HB'], ['HB', 'HB'], ['Full Board', 'FB'], ['FB', 'FB'],
    ['All Inclusive', 'AI'], ['All-Inclusive', 'AI'], ['Ultra All Inclusive', 'AI'],
    ['Room Only', 'RO'], ['RO', 'RO'], ['European Plan', 'RO'],
    ['Deluxe King Room - BB', 'BB'], ['Non-refundable Bed and Breakfast', 'BB'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeBoardBasis(input)).toBe(expected)
  })

  it('does not guess: unknown, empty and contradictory wording return null', () => {
    expect(normalizeBoardBasis('Chef special')).toBeNull()
    expect(normalizeBoardBasis('')).toBeNull()
    expect(normalizeBoardBasis(null)).toBeNull()
    expect(normalizeBoardBasis('Half Board or Full Board')).toBeNull()
    expect(normalizeBoardBasis('BB / HB')).toBeNull()
  })

  it('does not read "map" or "ap" inside ordinary words', () => {
    expect(normalizeBoardBasis('Bed and Breakfast Mapleton')).toBe('BB')
    expect(normalizeBoardBasis('Apartment')).toBeNull()
  })
})

describe('normalizeAmenities', () => {
  it('collapses synonyms to one code, de-duplicates and sorts', () => {
    expect(normalizeAmenities(['Free WiFi', 'Wireless Internet', 'Swimming Pool', 'Outdoor pool'])).toEqual({ codes: ['POOL', 'WIFI'], unmapped: [] })
  })

  it('returns unmapped labels instead of dropping them', () => {
    expect(normalizeAmenities(['WiFi', 'Helipad', ' ', null, 'Helipad'])).toEqual({ codes: ['WIFI'], unmapped: ['Helipad'] })
  })
})

describe('strong identifiers', () => {
  it('compares international phone numbers regardless of punctuation and 00/+ prefix', () => {
    expect(comparePhones('+971 4 399 8888', '00971-4-3998888')).toBe('international')
    expect(comparePhones('+971 4 399 8888', '+971 4 399 8889')).toBeNull()
  })

  it('treats a national-form match as weaker evidence than an international one', () => {
    expect(comparePhones('04 399 8888', '+971 4 399 8888')).toBe('national')
  })

  it('rejects placeholders and short numbers', () => {
    expect(normalizePhone('0000000000')).toBeNull()
    expect(normalizePhone('12345')).toBeNull()
    expect(comparePhones('', '+971 4 399 8888')).toBeNull()
  })

  it('folds postal and registry codes and ignores values too short to identify anything', () => {
    expect(normalizePostalCode('sw1a 1aa')).toBe('SW1A1AA')
    expect(normalizePostalCode('1')).toBe('')
    expect(normalizeRegistryCode('CN-1234 567')).toBe('CN1234567')
    expect(normalizeRegistryCode('AB1')).toBe('')
  })
})
