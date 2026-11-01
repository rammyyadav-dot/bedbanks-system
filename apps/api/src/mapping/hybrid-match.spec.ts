import { matchSupplierHotel, matchSupplierRoom, summarizeMappingDecisions } from './hybrid-match'
import { normalizeHotelIdentity, normalizeRoomIdentity } from './normalize'

const dubai = (hotelId: string, name: string, address: string, city = 'Dubai') => ({
  hotelId, name, address, city, countryCode: 'AE', latitude: 25.2048, longitude: 55.2708,
})

describe('hotel and room normalization', () => {
  it('keeps royal as part of the property identity', () => {
    expect(normalizeHotelIdentity({ name: 'Royal Ascot Hotel', city: 'Dubai', countryCode: 'ae' }).normalizedName).toBe('royal ascot hotel')
    expect(normalizeHotelIdentity({ name: 'Ascot Hotel', city: 'Dubai', countryCode: 'AE' }).normalizedName).not.toBe('royal ascot hotel')
  })

  it('normalizes punctuation, spacing, and address abbreviations without dropping the name', () => {
    const normalized = normalizeHotelIdentity({ name: '  DoubleTree  by Hilton, Dubai — Al Jadaf ', address: '1 Sheikh Zayed Rd.', city: 'Dubai', countryCode: 'AE', postalCode: '12345' })
    expect(normalized.normalizedName).toContain('doubletree')
    expect(normalized.normalizedName).toContain('hilton')
    expect(normalized.normalizedAddress).toContain('road')
    expect(normalized.normalizedAddress).toContain('12345')
    expect(normalized.normalizedCountryCode).toBe('AE')
  })

  it('keeps sea view and city view rooms distinct', () => {
    expect(normalizeRoomIdentity({ name: 'Deluxe Sea View' }).view).toBe('sea')
    expect(normalizeRoomIdentity({ name: 'Deluxe City View' }).view).toBe('city')
    expect(normalizeRoomIdentity({ name: 'Deluxe King Room' }).bedType).toBe('king')
    expect(normalizeRoomIdentity({ name: 'Deluxe Twin Room' }).bedType).toBe('twin')
  })
})

describe('hybrid hotel matching', () => {
  const catalog = [
    dubai('doubletree', 'DoubleTree by Hilton Dubai Al Jadaf', 'Al Jadaf Street'),
    dubai('ascot', 'Ascot Hotel Dubai', 'Al Rigga Road', 'Dubai'),
    dubai('royal', 'Royal Ascot Hotel Dubai', 'Trade Centre Road'),
    { hotelId: 'ascot-ad', name: 'Ascot Hotel', address: 'Corniche', city: 'Abu Dhabi', countryCode: 'AE', latitude: 24.4539, longitude: 54.3773 },
  ]

  it('maps spelling and word-order variants when the address agrees', () => {
    const decision = matchSupplierHotel({
      supplierHotelId: 'xml-1', name: 'Double Tree Hilton Al Jaddaf', address: 'Al Jadaf Street', city: 'Dubai', countryCode: 'AE', latitude: 25.2049, longitude: 55.2709,
    }, catalog)
    expect(decision.candidates[0].canonicalHotelId).toBe('doubletree')
    expect(['EXACT', 'HIGH_CONFIDENCE']).toContain(decision.tier)
    expect(decision.autoMap).toBe(true)
    expect(decision.candidates[0].matchingReasons.length).toBeGreaterThan(0)
  })

  it('does not automatically collapse Royal Ascot into Ascot', () => {
    const decision = matchSupplierHotel({
      supplierHotelId: 'xml-2', name: 'Royal Ascot Hotel Dubai', address: 'Trade Centre Road', city: 'Dubai', countryCode: 'AE', latitude: 25.22, longitude: 55.28,
    }, catalog)
    expect(decision.candidates.find((item) => item.canonicalHotelId === 'ascot')?.tier).not.toBe('EXACT')
    expect(decision.autoMap && decision.candidates[0].canonicalHotelId === 'ascot').toBe(false)
    expect(decision.candidates[0].canonicalHotelId).toBe('royal')
  })

  it('does not treat the same name in another city as the same property', () => {
    const decision = matchSupplierHotel({
      supplierHotelId: 'xml-3', name: 'Ascot Hotel', address: 'Corniche', city: 'Abu Dhabi', countryCode: 'AE', latitude: 24.45, longitude: 54.38,
    }, catalog)
    expect(decision.candidates[0].canonicalHotelId).toBe('ascot-ad')
    expect(decision.candidates.find((item) => item.canonicalHotelId === 'ascot')?.matchingReasons).toContain('city_mismatch')
  })

  it('rejects a different country and an approved mapping from another tenant catalog', () => {
    const otherCountry = matchSupplierHotel({ supplierHotelId: 'xml-4', name: 'Ascot Hotel Dubai', city: 'Dubai', countryCode: 'GB' }, catalog)
    expect(otherCountry.tier).toBe('NO_MATCH')
    const known = matchSupplierHotel({ supplierHotelId: 'xml-5', name: 'Unrelated', city: 'Dubai', countryCode: 'AE', knownCanonicalHotelId: 'doubletree' }, catalog)
    expect(known.tier).toBe('EXACT')
    expect(known.autoMap).toBe(true)
    expect(known.candidates[0].matchingReasons).toContain('approved_supplier_mapping')
  })

  it('leaves two close candidates for review', () => {
    const twins = [
      dubai('a', 'Marina Palace Hotel', 'Marina Walk'),
      dubai('b', 'Marina Palais Hotel', 'Marina Walk'),
    ]
    const decision = matchSupplierHotel({ supplierHotelId: 'xml-6', name: 'Marina Palacs Hotel', address: 'Marina Walk', city: 'Dubai', countryCode: 'AE', latitude: 25.2048, longitude: 55.2708 }, twins)
    expect(decision.autoMap).toBe(false)
    expect(decision.tier).toBe('REVIEW_REQUIRED')
    expect(decision.candidates.length).toBeGreaterThan(1)
  })
})

describe('hotel-scoped room matching', () => {
  const rooms = [
    { roomTypeId: 'king', hotelId: 'hotel-a', name: 'Deluxe King Room', maxOccupancy: 2 },
    { roomTypeId: 'twin', hotelId: 'hotel-a', name: 'Deluxe Twin Room', maxOccupancy: 2 },
    { roomTypeId: 'sea', hotelId: 'hotel-a', name: 'Deluxe Sea View', maxOccupancy: 2 },
    { roomTypeId: 'city', hotelId: 'hotel-a', name: 'Deluxe City View', maxOccupancy: 2 },
    { roomTypeId: 'other', hotelId: 'hotel-b', name: 'Deluxe King Room', maxOccupancy: 2 },
  ]

  it('maps a reordered room name and rejects a different bed, view, occupancy, or hotel', () => {
    const king = matchSupplierRoom({ name: 'King Deluxe Room', hotelId: 'hotel-a', occupancy: 2 }, rooms)
    expect(king.candidates[0].canonicalRoomTypeId).toBe('king')
    expect(['EXACT', 'HIGH_CONFIDENCE', 'REVIEW_REQUIRED']).toContain(king.tier)
    expect(matchSupplierRoom({ name: 'Deluxe Twin Room', hotelId: 'hotel-a' }, rooms).candidates[0].canonicalRoomTypeId).toBe('twin')
    expect(matchSupplierRoom({ name: 'Deluxe Sea View', hotelId: 'hotel-a' }, rooms).candidates.find((item) => item.canonicalRoomTypeId === 'city')?.reasons).toContain('view_mismatch')
    expect(matchSupplierRoom({ name: 'Deluxe King Room', hotelId: 'hotel-a', occupancy: 5 }, rooms).candidates.find((item) => item.canonicalRoomTypeId === 'king')?.tier).toBe('NO_MATCH')
    const cross = matchSupplierRoom({ name: 'Deluxe King Room', hotelId: 'hotel-a' }, rooms)
    expect(cross.candidates.some((item) => item.canonicalRoomTypeId === 'other')).toBe(false)
  })

  it('summarizes decisions without including supplier payloads', () => {
    const summary = summarizeMappingDecisions([
      { tier: 'EXACT', autoMap: true },
      { tier: 'REVIEW_REQUIRED', autoMap: false },
      { tier: 'NO_MATCH', autoMap: false },
    ])
    expect(summary).toMatchObject({ incoming: 3, exact: 1, autoMapped: 1, reviewRequired: 1, unmatched: 1 })
  })
})
