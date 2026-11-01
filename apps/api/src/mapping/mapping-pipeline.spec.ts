import { mapAmenities, mapBoardBases, mapSupplierHotels, mapSupplierRooms, reviewQueueOrder, summarizeRoutes } from './mapping-pipeline'

const catalog = [
  { hotelId: 'h_grand', name: 'Grand Hyatt Dubai', address: 'Oud Metha Road', city: 'Dubai', countryCode: 'AE', postalCode: '12345', latitude: 25.2285, longitude: 55.3273, phone: '+971 4 317 1234' },
  { hotelId: 'h_atlantis', name: 'Atlantis The Palm', address: 'Crescent Road', city: 'Dubai', countryCode: 'AE', latitude: 25.1304, longitude: 55.1171 },
  { hotelId: 'h_rosewood', name: 'Rosewood Hotel', address: '1 Main Street', city: 'Dubai', countryCode: 'AE', latitude: 25.2, longitude: 55.27 },
  { hotelId: 'h_rosewood2', name: 'Rosewood Hotels', address: '1 Main St', city: 'Dubai', countryCode: 'AE', latitude: 25.2001, longitude: 55.2701 },
]

describe('mapSupplierHotels', () => {
  it('auto-maps a known approved supplier mapping', () => {
    const [d] = mapSupplierHotels([{ supplierHotelId: 'S1', name: 'whatever', knownCanonicalHotelId: 'h_atlantis' }], catalog)
    expect(d).toMatchObject({ route: 'AUTO_MAP', method: 'KNOWN', canonicalHotelId: 'h_atlantis', confidence: 100 })
  })

  it('auto-maps the issue example by phone + name even though ids and names differ', () => {
    const [d] = mapSupplierHotels([{ supplierHotelId: 'DXB-GH-99', name: 'Grand Hyatt Hotel Dubai UAE', city: 'Dubai', countryCode: 'AE', phone: '+971 4 317 1234' }], catalog)
    expect(d).toMatchObject({ route: 'AUTO_MAP', method: 'DETERMINISTIC', canonicalHotelId: 'h_grand', confidence: 98 })
    expect(d.reasons).toContain('deterministic_phone')
  })

  it('sends a registry/name contradiction to the review queue, never auto-maps it', () => {
    const withRegistry = catalog.map((h) => h.hotelId === 'h_grand' ? { ...h, registryCode: 'DED-100200' } : h)
    const [d] = mapSupplierHotels([{ supplierHotelId: 'S2', name: 'Seaside Hostel', city: 'Dubai', countryCode: 'AE', registryCode: 'DED-100200' }], withRegistry)
    expect(d.route).toBe('REVIEW_QUEUE')
    expect(d.reasons).toContain('strong_identifier_conflict')
  })

  it('sends two near-identical canonical candidates to review instead of picking one', () => {
    const [d] = mapSupplierHotels([{ supplierHotelId: 'S3', name: 'Rosewood', address: '1 Main Street', city: 'Dubai', countryCode: 'AE', latitude: 25.2, longitude: 55.27 }], catalog)
    expect(d.route).not.toBe('AUTO_MAP')
  })

  it('leaves an unrelated property unmatched', () => {
    const [d] = mapSupplierHotels([{ supplierHotelId: 'S4', name: 'Zebra Safari Lodge', city: 'Nairobi', countryCode: 'KE' }], catalog)
    expect(d).toMatchObject({ route: 'UNMATCHED', canonicalHotelId: null })
  })

  it('demotes two supplier records that claim one canonical hotel (ADR 0004)', () => {
    const duplicate = (id: string) => ({ supplierHotelId: id, name: 'Grand Hyatt Dubai', city: 'Dubai', countryCode: 'AE', phone: '+971 4 317 1234' })
    const decisions = mapSupplierHotels([duplicate('A'), duplicate('B')], catalog)
    expect(decisions.map((d) => d.route)).toEqual(['REVIEW_QUEUE', 'REVIEW_QUEUE'])
    expect(decisions[0].reasons).toContain('supplier_duplicate_in_batch')
  })

  it('summarizes routes and orders the review queue strongest first', () => {
    const decisions = [
      { route: 'REVIEW_QUEUE' as const, confidence: 72, supplierHotelId: 'b' },
      { route: 'AUTO_MAP' as const, confidence: 100, supplierHotelId: 'a' },
      { route: 'REVIEW_QUEUE' as const, confidence: 84, supplierHotelId: 'c' },
      { route: 'UNMATCHED' as const, confidence: 10, supplierHotelId: 'd' },
    ]
    expect(summarizeRoutes(decisions)).toEqual({ incoming: 4, autoMapped: 1, reviewQueue: 2, unmatched: 1, averageConfidence: 67 })
    expect(reviewQueueOrder(decisions).map((d) => d.supplierHotelId)).toEqual(['c', 'b'])
  })
})

describe('mapSupplierRooms', () => {
  const rooms = [
    { roomTypeId: 'r_dk', hotelId: 'h_grand', name: 'Deluxe King Room', maxOccupancy: 3 },
    { roomTypeId: 'r_ste', hotelId: 'h_grand', name: 'Executive Suite', maxOccupancy: 4 },
    { roomTypeId: 'r_tw', hotelId: 'h_grand', name: 'Standard Twin Room', maxOccupancy: 2 },
  ]
  const room = (supplierRoomId: string, name: string, occupancy = 2) => ({ supplierRoomId, hotelId: 'h_grand', name, occupancy })

  it('treats "King Deluxe Room" and "Deluxe King" as the same product as "Deluxe King Room"', () => {
    const [a, b] = mapSupplierRooms([room('1', 'King Deluxe Room'), room('2', 'Deluxe King')], rooms)
    expect(a).toMatchObject({ route: 'AUTO_MAP', canonicalRoomTypeId: 'r_dk' })
    expect(b).toMatchObject({ route: 'AUTO_MAP', canonicalRoomTypeId: 'r_dk' })
  })

  it('does not map a different bed type, class or oversize party onto the same room', () => {
    const [twin, suite, big] = mapSupplierRooms([room('1', 'Deluxe Twin Room'), room('2', 'Superior King Room'), room('3', 'Deluxe King Room', 6)], rooms)
    expect(twin.route).not.toBe('AUTO_MAP')
    expect(suite.route).not.toBe('AUTO_MAP')
    expect(big.route).not.toBe('AUTO_MAP')
  })
})

describe('vocabulary mapping', () => {
  it('auto-maps known boards and queues unknown ones, de-duplicating supplier values', () => {
    expect(mapBoardBases(['BB', 'Bed and Breakfast', 'BB', 'Chef special'])).toEqual([
      { supplierValue: 'BB', code: 'BB', route: 'AUTO_MAP' },
      { supplierValue: 'Bed and Breakfast', code: 'BB', route: 'AUTO_MAP' },
      { supplierValue: 'Chef special', code: null, route: 'REVIEW_QUEUE' },
    ])
  })

  it('queues unknown amenities', () => {
    expect(mapAmenities(['Free WiFi', 'Helipad']).map((d) => d.route)).toEqual(['AUTO_MAP', 'REVIEW_QUEUE'])
  })
})
