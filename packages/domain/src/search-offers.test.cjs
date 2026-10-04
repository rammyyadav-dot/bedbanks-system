const assert = require('node:assert/strict')
const { test } = require('node:test')
const { cityDestinationId, validSearchCriteria, validateSearchHotels, validateAgentSearchResponse } = require('./search-offers.cjs')

// Stay dates are relative to today so these tests do not expire as the calendar moves.
const stayDay = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)
const criteria = {
  destination: 'Dubai', checkIn: stayDay(30), checkOut: stayDay(33),
  rooms: 1, adults: 2, children: 1, childAges: [8], nationality: 'IN', currency: 'AED',
}
function hotel() {
  return { hotelId: 'hotel-a', name: 'Test Hotel', destination: 'Dubai', starRating: 5, supplierId: 'supplier-a',
    supplierHotelId: 'sh-a', rooms: [{ roomTypeId: 'room-a', name: 'King Room', supplierRoomId: 'sr-a',
      rates: [{ offerId: 'offer-a', hotelId: 'hotel-a', roomTypeId: 'room-a',
        tenantId: 'tenant-a', providerId: 'provider-a', canonicalHotelId: 'hotel-a', canonicalRoomTypeId: 'room-a',
        supplierId: 'supplier-a', supplierRoomId: 'sr-a', ratePlanId: 'plan-a',
        ratePlanName: 'Flexible', boardBasisId: 'board-a', boardBasisName: 'Breakfast',
        supplierRateId: 'rate-a', offerToken: 'opaque-token', expiresAt: '2099-01-01T00:00:00Z',
        occupancy: { rooms: 1, adults: 2, children: 1, childAges: [8] },
        availability: 'limited', available: true, cancellation: { refundable: true, summary: 'Free until deadline',
          deadline: '2098-12-01T00:00:00Z' },
        total: { amountMinor: 125099, currency: 'AED' }, netAmountMinor: 110000,
        taxAmountMinor: 10000, feeAmountMinor: 99, totalAmountMinor: 120099,
        markupAmountMinor: 5000, sellAmountMinor: 125099, paymentType: 'credit', source: 'bedbank' }] }] }
}
test('retains nested room/rate/board/policy/total and strips unknown fields', () => {
  const sample = hotel()
  sample.rooms[0].rates[0].internalCredential = 'never return'
  const result = validateSearchHotels([sample], criteria)
  assert.equal(result.ok, true)
  const offer = result.hotels[0].rooms[0].rates[0]
  assert.equal(offer.roomTypeId, result.hotels[0].rooms[0].roomTypeId)
  assert.equal(offer.boardBasisId, 'board-a')
  assert.equal(offer.cancellation.summary, 'Free until deadline')
  assert.deepEqual(offer.total, { amountMinor: 125099, currency: 'AED' })
  assert.equal('internalCredential' in offer, false)
  assert.equal('contractId' in offer, false)
})
test('preserves an optional contract id', () => {
  const sample = hotel()
  sample.rooms[0].rates[0].contractId = 'contract-a'
  const result = validateSearchHotels([sample], criteria)
  assert.equal(result.ok, true)
  assert.equal(result.hotels[0].rooms[0].rates[0].contractId, 'contract-a')
  const blank = hotel()
  blank.rooms[0].rates[0].contractId = ' '
  assert.equal(validateSearchHotels([blank], criteria).ok, false)
})
for (const [name, mutate] of [
  ['missing board ID', (h) => { delete h.rooms[0].rates[0].boardBasisId }],
  ['conflicting room ID', (h) => { h.rooms[0].rates[0].roomTypeId = 'room-b' }],
  ['conflicting supplier ID', (h) => { h.rooms[0].rates[0].supplierId = 'supplier-b' }],
  ['expired offer', (h) => { h.rooms[0].rates[0].expiresAt = '2020-01-01T00:00:00Z' }],
  ['fractional amount', (h) => { h.rooms[0].rates[0].total.amountMinor = 1250.5 }],
  ['unsafe amount', (h) => { h.rooms[0].rates[0].total.amountMinor = Number.MAX_SAFE_INTEGER + 1 }],
  ['cross currency', (h) => { h.rooms[0].rates[0].total.currency = 'USD' }],
  ['other occupancy', (h) => { h.rooms[0].rates[0].occupancy.childAges = [9] }],
  ['inconsistent sell amount', (h) => { h.rooms[0].rates[0].sellAmountMinor += 1 }],
]) test(`rejects ${name}`, () => {
  const sample = hotel(); mutate(sample)
  assert.deepEqual(validateSearchHotels([sample], criteria), { ok: false, reason: 'mapping_unavailable' })
})
test('rejects an offer from another tenant when tenant context is supplied', () => {
  assert.equal(validateSearchHotels([hotel()], criteria, Date.now(), 'tenant-b').ok, false)
})
test('enforces canonical hotel, star, board, refundable, price and availability filters', () => {
  const soldOut = hotel()
  soldOut.rooms[0].rates[0] = { ...soldOut.rooms[0].rates[0], offerId: 'sold-out', availability: 'sold_out', available: false }
  const matching = hotel()
  matching.rooms[0].rates.push(soldOut.rooms[0].rates[0])
  const filteredCriteria = { ...criteria, canonicalHotelIds: ['hotel-a'], filters: {
    starRatings: [5], boardBasisIds: ['board-a'], refundableOnly: true,
    minPriceMinor: 125000, maxPriceMinor: 126000,
  } }
  const result = validateSearchHotels([matching], filteredCriteria)
  assert.equal(result.ok, true)
  assert.equal(result.hotels.length, 1)
  assert.deepEqual(result.hotels[0].rooms[0].rates.map((rate) => rate.offerId), ['offer-a'])
  assert.equal(validateSearchHotels([matching], { ...filteredCriteria, filters: { starRatings: [4] } }).hotels.length, 0)
  assert.equal(validateSearchHotels([matching], { ...filteredCriteria, filters: { boardBasisIds: ['other'] } }).hotels.length, 0)
  assert.equal(validateSearchHotels([matching], { ...filteredCriteria, filters: { minPriceMinor: 125100 } }).hotels.length, 0)
})
test('AED 700 is 70000 minor of the total stay, not 700 per night', () => {
  const stayTotal = hotel()
  Object.assign(stayTotal.rooms[0].rates[0], {
    sellAmountMinor: 70000, totalAmountMinor: 65000, markupAmountMinor: 5000,
    netAmountMinor: 55000, taxAmountMinor: 10000, feeAmountMinor: 0,
    total: { amountMinor: 70000, currency: 'AED' },
  })
  const threeNights = hotel()
  threeNights.hotelId = 'hotel-b'
  threeNights.rooms[0].roomTypeId = 'room-b'
  Object.assign(threeNights.rooms[0].rates[0], {
    offerId: 'offer-b', hotelId: 'hotel-b', canonicalHotelId: 'hotel-b',
    roomTypeId: 'room-b', canonicalRoomTypeId: 'room-b',
    sellAmountMinor: 210000, totalAmountMinor: 200000, markupAmountMinor: 10000,
    netAmountMinor: 180000, taxAmountMinor: 20000, feeAmountMinor: 0,
    total: { amountMinor: 210000, currency: 'AED' },
  })
  const capped = validateSearchHotels([stayTotal, threeNights], { ...criteria, filters: { maxPriceMinor: 70000 } })
  assert.equal(capped.ok, true)
  assert.deepEqual(capped.hotels.map((row) => row.hotelId), ['hotel-a'])
  assert.equal(capped.hotels[0].rooms[0].rates[0].sellAmountMinor, 70000)
  assert.equal('nightlyAmountMinor' in capped.hotels[0].rooms[0].rates[0], false)
  const floor = validateSearchHotels([stayTotal], { ...criteria, filters: { minPriceMinor: 70000, maxPriceMinor: 70000 } })
  assert.equal(floor.hotels.length, 1)
  assert.equal(validateSearchHotels([stayTotal], { ...criteria, filters: { minPriceMinor: 70001 } }).hotels.length, 0)
})
test('enforces the bounded hotel result limit after validation', () => {
  const second = hotel()
  second.hotelId = 'hotel-b'; second.rooms[0].rates[0].hotelId = 'hotel-b'; second.rooms[0].rates[0].canonicalHotelId = 'hotel-b'
  second.rooms[0].rates[0].offerId = 'offer-b'
  assert.equal(validateSearchHotels([hotel(), second], { ...criteria, limit: 1 }).hotels.length, 1)
})
function numberedHotel(index) {
  const sample = hotel()
  const hotelId = `hotel-${index}`
  sample.hotelId = hotelId
  sample.name = `Hotel ${String(index).padStart(2, '0')}`
  sample.rooms[0].rates[0].hotelId = hotelId
  sample.rooms[0].rates[0].canonicalHotelId = hotelId
  sample.rooms[0].rates[0].offerId = `offer-${index}`
  return sample
}
test('pages a stable order without duplicates or a second slice', () => {
  const hotels = [0, 1, 2].map(numberedHotel)
  const first = validateSearchHotels(hotels, { ...criteria, limit: 2, offset: 0 })
  const second = validateSearchHotels(hotels, { ...criteria, limit: 2, offset: 2 })
  assert.equal(first.ok, true)
  assert.deepEqual(first.hotels.map((row) => row.hotelId), ['hotel-0', 'hotel-1'])
  assert.equal(first.matchedTotal, 3)
  assert.deepEqual(second.hotels.map((row) => row.hotelId), ['hotel-2'])
  assert.equal(second.matchedTotal, 3)
  const ids = [...first.hotels, ...second.hotels].map((row) => row.hotelId)
  assert.equal(new Set(ids).size, 3)
})
test('keeps an already paged response and rejects an inconsistent continuation', () => {
  const pageCriteria = { ...criteria, limit: 1, offset: 1 }
  const response = { version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z',
    status: 'available', request: pageCriteria, hotels: [numberedHotel(1)], total: 1,
    pagination: { limit: 1, offset: 1, total: 2, hasMore: false },
    providerSummary: { queried: 1, succeeded: 1, failed: 0 } }
  const validated = validateAgentSearchResponse(response, pageCriteria)
  assert.equal(validated.ok, true)
  assert.equal(validated.response.hotels[0].hotelId, 'hotel-1')
  assert.deepEqual(validated.response.pagination, { limit: 1, offset: 1, total: 2, hasMore: false })
  assert.equal(validateAgentSearchResponse({ ...response, pagination: { limit: 1, offset: 1, total: 3, hasMore: true, nextOffset: 2 } }, pageCriteria).ok, true)
  const short = { ...response, request: { ...criteria, limit: 2 }, hotels: [numberedHotel(0)], total: 1,
    pagination: { limit: 2, offset: 0, total: 3, hasMore: true, nextOffset: 2 } }
  assert.equal(validateAgentSearchResponse(short, { ...criteria, limit: 2 }).ok, false)
  assert.equal(validSearchCriteria({ ...criteria, offset: -1 }), false)
  assert.equal(validSearchCriteria({ ...criteria, offset: 1.5 }), false)
  assert.equal(validSearchCriteria({ ...criteria, offset: 10001 }), false)
  assert.equal(validSearchCriteria({ ...criteria, offset: 0 }), true)
  assert.equal(validateAgentSearchResponse(response, criteria).ok, false)
})
test('rejects duplicated offer ID and malformed search dates', () => {
  const sample = hotel(); sample.rooms[0].rates.push({ ...sample.rooms[0].rates[0] })
  assert.equal(validateSearchHotels([sample], criteria).ok, false)
  assert.equal(validSearchCriteria({ ...criteria, checkOut: criteria.checkIn }), false)
  assert.equal(validSearchCriteria({ ...criteria, children: 2 }), false)
})
test('validates version, exact search context and status before rendering', () => {
  const response = { version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z',
    status: 'available', request: criteria, hotels: [hotel()], total: 1,
    providerSummary: { queried: 1, succeeded: 1, failed: 0 } }
  assert.equal(validateAgentSearchResponse(response, criteria).ok, true)
  assert.equal(validateAgentSearchResponse({ ...response, request: { ...criteria, adults: 3 } }, criteria).ok, false)
  assert.equal(validateAgentSearchResponse({ ...response, version: 2 }, criteria).ok, false)
  assert.equal(validateAgentSearchResponse({ ...response, status: 'no_availability' }, criteria).ok, false)
})
test('rejects past, overlong, unsupported and unknown search input', () => {
  assert.equal(validSearchCriteria({ ...criteria, checkIn: '2020-01-01', checkOut: '2020-01-02' }), false)
  assert.equal(validSearchCriteria({ ...criteria, checkOut: stayDay(30 + 61) }), false)
  assert.equal(validSearchCriteria({ ...criteria, currency: 'ZZZ' }), false)
  assert.equal(validSearchCriteria({ ...criteria, nationality: 'ZZ' }), false)
  assert.equal(validSearchCriteria({ ...criteria, unsafe: true }), false)
})

test('accepts a canonical city or hotel and keeps free-text searches valid for existing callers', () => {
  const city = { type: 'city', id: cityDestinationId('AE', 'Dubai'), countryCode: 'AE' }
  assert.equal(city.id, 'city:AE:dubai')
  assert.equal(validSearchCriteria({ ...criteria, destinationRef: city }), true)
  assert.equal(validSearchCriteria({ ...criteria, destinationRef: { type: 'hotel', id: 'hotel-a' } }), true)
  assert.equal(validSearchCriteria({ ...criteria, destinationRef: { type: 'area', id: 'marina' } }), false)
  assert.equal(validSearchCriteria({ ...criteria, destinationRef: { type: 'city', id: 'city:AE:not a city', countryCode: 'AE' } }), false)
  assert.equal(validSearchCriteria(criteria), true)
})

test('keeps per-room occupancy and rejects a flattened mismatch', () => {
  const uniform = { ...criteria, rooms: 2, adults: 2, children: 0, childAges: [], roomStays: [{ adults: 2, children: [] }, { adults: 2, children: [] }] }
  assert.equal(validSearchCriteria(uniform), true)
  const mixed = {
    ...criteria, rooms: 2, adults: 4, children: 1, childAges: [7],
    roomStays: [{ adults: 2, children: [] }, { adults: 2, children: [{ age: 7 }] }],
  }
  assert.equal(validSearchCriteria(mixed), true)
  assert.equal(validSearchCriteria({ ...mixed, adults: 2 }), false)
  assert.equal(validSearchCriteria({ ...uniform, roomStays: [{ adults: 2, children: [{ age: null }] }, { adults: 2, children: [] }] }), false)
  const sample = hotel()
  sample.rooms[0].rates[0].occupancy = { rooms: 2, adults: 2, children: 0, childAges: [] }
  assert.equal(validateSearchHotels([sample], uniform).ok, true)
  assert.equal(validateSearchHotels([sample], mixed).ok, false)
})

test('echoes room occupancy, nationality, currency, sort and filters through a paged response', () => {
  const stays = [{ adults: 2, children: [] }, { adults: 2, children: [{ age: 7 }] }]
  const pageCriteria = {
    ...criteria, rooms: 2, adults: 4, children: 1, childAges: [7], roomStays: stays,
    nationality: 'AE', currency: 'AED', sort: 'name', limit: 25, offset: 0,
    filters: { starRatings: [5], refundableOnly: true },
    destinationRef: { type: 'city', id: 'city:AE:dubai', countryCode: 'AE' },
  }
  const sample = hotel()
  sample.rooms[0].rates[0].occupancy = { rooms: 2, adults: 4, children: 1, childAges: [7] }
  const response = {
    version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z',
    status: 'available', request: pageCriteria, hotels: [sample], total: 1,
    providerSummary: { queried: 1, succeeded: 1, failed: 0 },
  }
  const validated = validateAgentSearchResponse(response, pageCriteria)
  assert.equal(validated.ok, true)
  assert.deepEqual(validated.response.request.roomStays, stays)
  assert.equal(validated.response.request.nationality, 'AE')
  assert.equal(validated.response.request.currency, 'AED')
  assert.equal(validated.response.request.sort, 'name')
  assert.deepEqual(validated.response.request.filters, pageCriteria.filters)
  const later = { ...pageCriteria, offset: 25 }
  assert.equal(validSearchCriteria(later), true)
  assert.equal(validateAgentSearchResponse(response, later).ok, false)
})

test('matches a city exactly and a hotel only by its canonical id', () => {
  const marina = hotel()
  marina.hotelId = 'hotel-b'
  marina.name = 'Marina Hotel'
  marina.destination = 'Dubai Marina'
  marina.rooms[0].roomTypeId = 'room-b'
  marina.rooms[0].rates[0].offerId = 'offer-b'
  marina.rooms[0].rates[0].hotelId = 'hotel-b'
  marina.rooms[0].rates[0].canonicalHotelId = 'hotel-b'
  marina.rooms[0].rates[0].roomTypeId = 'room-b'
  marina.rooms[0].rates[0].canonicalRoomTypeId = 'room-b'
  const city = { ...criteria, destinationRef: { type: 'city', id: 'city:AE:dubai', countryCode: 'AE' } }
  const matched = validateSearchHotels([hotel(), marina], city)
  assert.equal(matched.ok, true)
  assert.deepEqual(matched.hotels.map((item) => item.hotelId), ['hotel-a'])
  const property = { ...criteria, destination: 'Dubai', canonicalHotelIds: ['hotel-b'], destinationRef: { type: 'hotel', id: 'hotel-b' } }
  const only = validateSearchHotels([hotel(), marina], property)
  assert.equal(only.ok, true)
  assert.deepEqual(only.hotels.map((item) => item.hotelId), ['hotel-b'])
})

test('sorts and filters before the 25-hotel page window', () => {
  const hotels = Array.from({ length: 30 }, (_, index) => {
    const sample = hotel()
    const id = `hotel-${String(index).padStart(2, '0')}`
    sample.hotelId = id
    sample.name = `Hotel ${String.fromCharCode(90 - (index % 26))}${index}`
    sample.starRating = (index % 5) + 1
    sample.propertyType = index % 2 === 0 ? 'Hotel' : 'Apartment'
    sample.rooms[0].rates[0].offerId = `offer-${index}`
    sample.rooms[0].rates[0].hotelId = id
    sample.rooms[0].rates[0].canonicalHotelId = id
    sample.rooms[0].rates[0].sellAmountMinor = 100000 - index * 100
    sample.rooms[0].rates[0].totalAmountMinor = sample.rooms[0].rates[0].sellAmountMinor
    sample.rooms[0].rates[0].netAmountMinor = sample.rooms[0].rates[0].sellAmountMinor
    sample.rooms[0].rates[0].taxAmountMinor = 0
    sample.rooms[0].rates[0].feeAmountMinor = 0
    sample.rooms[0].rates[0].markupAmountMinor = 0
    sample.rooms[0].rates[0].total.amountMinor = sample.rooms[0].rates[0].sellAmountMinor
    return sample
  })
  const priced = { ...criteria, limit: 25, sort: 'price', filters: { propertyTypes: ['Hotel'] } }
  const page = validateSearchHotels(hotels, priced)
  assert.equal(page.ok, true)
  assert.equal(page.hotels.length, 15)
  assert.equal(page.matchedTotal, 15)
  assert.equal(page.hotels.every((item) => item.propertyType === 'Hotel'), true)
  const prices = page.hotels.map((item) => item.rooms[0].rates[0].sellAmountMinor)
  assert.deepEqual(prices, [...prices].sort((left, right) => left - right))
  const second = validateSearchHotels(hotels, { ...criteria, limit: 25, offset: 25, sort: 'name' })
  assert.equal(second.ok, true)
  assert.equal(second.hotels.length, 5)
  assert.equal(second.hotels[0].rooms[0].rates[0].occupancy.childAges[0], 8)
})

test('keeps stored address and drops a hotel with a malformed coordinate', () => {
  const sample = hotel()
  sample.address = '1 Sheikh Zayed Road'
  sample.propertyType = 'Hotel'
  sample.latitude = '25.204849'
  sample.longitude = '55.270782'
  sample.timeZone = 'Asia/Dubai'
  const result = validateSearchHotels([sample], criteria)
  assert.equal(result.ok, true)
  assert.equal(result.hotels[0].address, '1 Sheikh Zayed Road')
  assert.equal(result.hotels[0].latitude, '25.204849')
  assert.equal('photoUrl' in result.hotels[0], false)
  const broken = hotel()
  broken.latitude = '25.2'
  assert.equal(validateSearchHotels([broken], criteria).ok, false)
})

test('keeps a well-formed primary image reference and rejects a malformed one (ADR 0027)', () => {
  const image = { imageId: 'img-1', altText: 'Pool at sunset', width: 1600, height: 1200 }
  const kept = validateSearchHotels([{ ...hotel(), primaryImage: { ...image, url: 'https://evil.example/x.png', extra: 1 } }], criteria)
  assert.equal(kept.ok, true)
  assert.deepEqual(kept.hotels[0].primaryImage, image) // unknown fields, including any URL, are stripped
  assert.equal(validateSearchHotels([hotel()], criteria).hotels[0].primaryImage, undefined) // omitted, never a placeholder
  for (const bad of [{}, { ...image, imageId: '' }, { ...image, altText: '' }, { ...image, altText: 'x'.repeat(201) }, { ...image, width: 0 }, { ...image, height: 1.5 }, 'img-1', null]) {
    assert.equal(validateSearchHotels([{ ...hotel(), primaryImage: bad }], criteria).ok, false, JSON.stringify(bad))
  }
})

test('an on-request rate stays in results as not available, and a contradictory flag is rejected', () => {
  const onRequest = hotel()
  onRequest.rooms[0].rates[0] = { ...onRequest.rooms[0].rates[0], availability: 'on_request', available: false }
  const kept = validateSearchHotels([onRequest], criteria)
  assert.equal(kept.ok, true)
  assert.equal(kept.hotels[0].rooms[0].rates[0].availability, 'on_request')
  assert.equal(kept.hotels[0].rooms[0].rates[0].available, false)
  const lying = hotel()
  lying.rooms[0].rates[0] = { ...lying.rooms[0].rates[0], availability: 'on_request', available: true }
  assert.equal(validateSearchHotels([lying], criteria).ok, false)
})
