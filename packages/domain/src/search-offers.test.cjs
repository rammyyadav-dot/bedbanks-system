const assert = require('node:assert/strict')
const { test } = require('node:test')
const { validSearchCriteria, validateSearchHotels, validateAgentSearchResponse } = require('./search-offers.cjs')

const criteria = {
  destination: 'Dubai', checkIn: '2026-10-01', checkOut: '2026-10-04',
  rooms: 1, adults: 2, children: 1, childAges: [8], nationality: 'IN', currency: 'AED',
}
function hotel() {
  return { hotelId: 'hotel-a', name: 'Test Hotel', destination: 'Dubai', supplierId: 'supplier-a',
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
