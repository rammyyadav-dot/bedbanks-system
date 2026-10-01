const assert = require('node:assert/strict')
const { test } = require('node:test')
const { validSearchCriteria, validateSearchHotels, validateAgentSearchResponse } = require('./search-offers.cjs')

const criteria = {
  destination: 'Dubai', checkIn: '2026-10-01', checkOut: '2026-10-04',
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
  assert.equal(validSearchCriteria({ ...criteria, checkOut: '2026-12-01' }), false)
  assert.equal(validSearchCriteria({ ...criteria, currency: 'ZZZ' }), false)
  assert.equal(validSearchCriteria({ ...criteria, nationality: 'ZZ' }), false)
  assert.equal(validSearchCriteria({ ...criteria, unsafe: true }), false)
})
