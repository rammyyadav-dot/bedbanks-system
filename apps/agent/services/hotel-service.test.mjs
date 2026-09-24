import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ApiHotelService } from './hotel-service.ts'

const criteria = {
  destination: 'Dubai', checkIn: '2026-10-01', checkOut: '2026-10-04',
  rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED',
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

test('explicit development demo is labelled and filtered without network', async () => {
  process.env.NODE_ENV = 'development'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'true'
  globalThis.fetch = () => { throw new Error('demo must not call API') }
  const result = await new ApiHotelService().search({ ...criteria, destination: 'Palace' }, 'tenant-a')
  assert.equal(result.status, 'demo')
  assert.equal(result.isDemo, true)
  assert.equal(result.hotels.length, 1)
})

test('production never serves demo on supplier failure', async () => {
  process.env.NODE_ENV = 'production'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'true'
  globalThis.fetch = async () => { throw new Error('offline') }
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.deepEqual(result.hotels, [])
  assert.equal(result.status, 'provider_unavailable')
})

test('search passes tenant context but blocks structurally incomplete supplier offers', async () => {
  process.env.NODE_ENV = 'production'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'false'
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://example.invalid/agent/search')
    assert.equal(init.headers['x-fbeds-tenant-id'], 'tenant-a')
    assert.equal(init.credentials, 'include')
    return new Response(JSON.stringify({ data: { hotels: [{ hotelId: 'h1', rates: [{ rateId: 'r1', roomName: 'King', board: 'BB' }] }] } }), { status: 200 })
  }
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-a')
  assert.equal(result.status, 'mapping_unavailable')
  assert.deepEqual(result.hotels, [])
})

test('authorization failures never become sample inventory', async () => {
  process.env.NODE_ENV = 'production'
  process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY = 'false'
  globalThis.fetch = async () => new Response(null, { status: 403 })
  const result = await new ApiHotelService('https://example.invalid').search(criteria, 'tenant-b')
  assert.equal(result.status, 'access_denied')
  assert.equal(result.total, 0)
})
