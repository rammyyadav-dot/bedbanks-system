import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiHotelService } from './hotel-service.ts'

const criteria = {
  destination: 'Dubai', checkIn: '2026-10-01', checkOut: '2026-10-04',
  rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED',
}
const hotel = {
  hotelId: 'h1', name: 'Hotel', destination: 'Dubai', starRating: 5, supplierId: 's1', supplierHotelId: 'sh1',
  rooms: [{ roomTypeId: 'r1', name: 'King', supplierRoomId: 'sr1', rates: [{
    offerId: 'o1', hotelId: 'h1', roomTypeId: 'r1', supplierId: 's1', supplierRoomId: 'sr1',
    tenantId: 'tenant-a', providerId: 'provider-a', canonicalHotelId: 'h1', canonicalRoomTypeId: 'r1',
    ratePlanId: 'p1', ratePlanName: 'Flexible', boardBasisId: 'b1', boardBasisName: 'Breakfast',
    supplierRateId: 'sp1', expiresAt: '2099-01-01T00:00:00Z',
    occupancy: { rooms: 1, adults: 2, children: 0, childAges: [] },
    cancellation: { refundable: true, summary: 'Free until deadline' }, availability: 'available', available: true,
    total: { amountMinor: 125099, currency: 'AED' }, netAmountMinor: 110000, taxAmountMinor: 10000,
    feeAmountMinor: 99, totalAmountMinor: 120099, markupAmountMinor: 5000, sellAmountMinor: 125099,
    paymentType: 'credit', source: 'bedbank',
  }] }],
}
const originalFetch = globalThis.fetch
const originalNodeEnv = process.env.NODE_ENV
afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})
test('live canonical offer retains nested authoritative total', async () => {
  process.env.NODE_ENV = 'production'
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example.invalid/agent/search')
    assert.equal(init.headers['x-fbeds-tenant-id'], 'tenant-a')
    assert.equal(init.credentials, 'include')
    return new Response(JSON.stringify({ data: { version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z', status: 'available',
      request: criteria, hotels: [hotel], total: 1, providerSummary: { queried: 1, succeeded: 1, failed: 0 } } }), { status: 200 })
  }
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.equal(result.status, 'available')
  assert.equal('hotels' in result, false)
  assert.equal(result.liveHotels[0].rooms[0].rates[0].total.amountMinor, 125099)
  assert.equal(result.liveHotels[0].rooms[0].rates[0].boardBasisId, 'b1')
})
test('keeps server pagination instead of treating the page as the full result', async () => {
  process.env.NODE_ENV = 'production'
  const pageCriteria = { ...criteria, limit: 1, offset: 1 }
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).offset, 1)
    return new Response(JSON.stringify({ data: { version: 1, searchId: 'search-b', requestId: 'request-b', generatedAt: '2026-09-25T00:00:00Z', status: 'available',
      request: pageCriteria, hotels: [hotel], total: 1,
      pagination: { limit: 1, offset: 1, total: 2, hasMore: false },
      providerSummary: { queried: 1, succeeded: 1, failed: 0 } } }), { status: 200 })
  }
  const result = await new ApiHotelService('https://example.invalid').search(pageCriteria, 'tenant-a')
  assert.equal(result.liveHotels.length, 1)
  assert.deepEqual(result.pagination, { limit: 1, offset: 1, total: 2, hasMore: false })
})
test('missing room mapping cannot be displayed live', async () => {
  process.env.NODE_ENV = 'production'
  const malformed = structuredClone(hotel)
  delete malformed.rooms[0].rates[0].roomTypeId
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z', status: 'available',
    request: criteria, hotels: [malformed], total: 1, providerSummary: { queried: 1, succeeded: 1, failed: 0 } }), { status: 200 })
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.equal(result.status, 'mapping_unavailable')
  assert.deepEqual(result.liveHotels, [])
})
test('an unavailable supplier response resolves as provider_unavailable and does not throw', async () => {
  process.env.NODE_ENV = 'production'
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'https://supplier.internal/secret' }), { status: 503 })
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.equal(result.status, 'provider_unavailable')
  assert.deepEqual(result.liveHotels, [])
  assert.equal(JSON.stringify(result).includes('supplier.internal'), false)
})
test('a provider failure never becomes availability, even if a demo flag is set', async () => {
  process.env.NODE_ENV = 'development'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'true'
  globalThis.fetch = async () => { throw Error('offline') }
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.equal(result.status, 'provider_unavailable')
  assert.deepEqual(result.liveHotels, [])
  assert.equal(result.total, 0)
})
test('empty and forbidden responses are distinct', async () => {
  process.env.NODE_ENV = 'production'
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z', status: 'no_availability',
    request: criteria, hotels: [], total: 0, providerSummary: { queried: 1, succeeded: 1, failed: 0 } }), { status: 200 })
  assert.equal((await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')).status, 'empty')
  globalThis.fetch = async () => new Response(null, { status: 403 })
  assert.equal((await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-b')).status, 'access_denied')
})
test('recheck sends only canonical offer identity and expected display amount without allocating inventory', async () => {
  const rate = hotel.rooms[0].rates[0]
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example.invalid/agent/rates/recheck')
    assert.equal(init.headers['x-fbeds-tenant-id'], 'tenant-a')
    assert.deepEqual(JSON.parse(init.body), { offerId: 'o1', searchId: 'search-a', expectedCurrency: 'AED', expectedSellAmountMinor: 125099 })
    return new Response(JSON.stringify({ data: { offerId: 'o1', searchId: 'search-a', requestId: 'request-a', status: 'rechecked', currency: 'AED', sellAmountMinor: 125099, expiresAt: '2099-01-01T00:15:00.000Z' } }), { status: 200 })
  }
  const result = await new ApiHotelService('https://example.invalid').recheckOffer(rate, 'search-a', 'tenant-a')
  assert.equal(result.status, 'rechecked')
  assert.equal(result.sellAmountMinor, 125099)
})
test('price changes and malformed recheck responses fail closed', async () => {
  const rate = hotel.rooms[0].rates[0]
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { offerId: 'o1', searchId: 'search-a', requestId: 'request-a',
    status: 'price_changed', currency: 'AED', sellAmountMinor: 125100 } }), { status: 409 })
  assert.deepEqual(await new ApiHotelService('https://example.invalid').recheckOffer(rate, 'search-a', 'tenant-a'), {
    offerId: 'o1', searchId: 'search-a', requestId: 'request-a', status: 'price_changed', currency: 'AED', sellAmountMinor: 125100,
  })
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { offerId: 'other-offer', searchId: 'search-a', requestId: 'request-a', status: 'rechecked' } }), { status: 200 })
  assert.equal((await new ApiHotelService('https://example.invalid').recheckOffer(rate, 'search-a', 'tenant-a')).status, 'provider_unavailable')
})
