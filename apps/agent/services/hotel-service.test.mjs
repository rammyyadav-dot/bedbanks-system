import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiHotelService } from './hotel-service.ts'

const criteria = {
  destination: 'Dubai', checkIn: '2026-10-01', checkOut: '2026-10-04',
  rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED',
}
const hotel = {
  hotelId: 'h1', name: 'Hotel', destination: 'Dubai', supplierId: 's1', supplierHotelId: 'sh1',
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
const originalDemo = process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY
const originalNodeEnv = process.env.NODE_ENV
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalDemo === undefined) delete process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY
  else process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = originalDemo
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})
test('explicit nonproduction demo is labelled', async () => {
  process.env.NODE_ENV = 'development'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'true'
  globalThis.fetch = () => { throw Error('demo must not call API') }
  const result = await new ApiHotelService().search({ ...criteria, destination: 'Palace' }, 'tenant-a')
  assert.equal(result.status, 'demo')
  assert.equal(result.hotels.length, 1)
  assert.deepEqual(result.liveHotels, [])
})
test('live canonical offer retains nested authoritative total', async () => {
  process.env.NODE_ENV = 'production'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'true'
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example.invalid/agent/search')
    assert.equal(init.headers['x-fbeds-tenant-id'], 'tenant-a')
    assert.equal(init.credentials, 'include')
    return new Response(JSON.stringify({ data: { version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z', status: 'available',
      request: criteria, hotels: [hotel], total: 1, providerSummary: { queried: 1, succeeded: 1, failed: 0 } } }), { status: 200 })
  }
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.equal(result.status, 'available')
  assert.deepEqual(result.hotels, [])
  assert.equal(result.liveHotels[0].rooms[0].rates[0].total.amountMinor, 125099)
  assert.equal(result.liveHotels[0].rooms[0].rates[0].boardBasisId, 'b1')
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
test('production failure never becomes demo availability', async () => {
  process.env.NODE_ENV = 'production'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'true'
  globalThis.fetch = async () => { throw Error('offline') }
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.equal(result.status, 'provider_unavailable')
  assert.deepEqual(result.hotels, [])
})
test('empty and forbidden responses are distinct', async () => {
  process.env.NODE_ENV = 'production'
  globalThis.fetch = async () => new Response(JSON.stringify({ version: 1, searchId: 'search-a', requestId: 'request-a', generatedAt: '2026-09-25T00:00:00Z', status: 'no_availability',
    request: criteria, hotels: [], total: 0, providerSummary: { queried: 1, succeeded: 1, failed: 0 } }), { status: 200 })
  assert.equal((await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')).status, 'empty')
  globalThis.fetch = async () => new Response(null, { status: 403 })
  assert.equal((await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-b')).status, 'access_denied')
})
