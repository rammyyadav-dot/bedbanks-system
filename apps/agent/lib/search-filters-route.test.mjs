import assert from 'node:assert/strict'
import test from 'node:test'
import { routes } from '@bedbanks/contracts/agent'
import { searchFiltersResponse } from './search-filters-route.ts'

const call = async (query) => {
  const response = searchFiltersResponse(new URL(`https://portal.test${routes.agentLocal.searchFilters}?${query}`), 'req-1', new Date('2026-10-26T00:00:00Z'))
  return { response, body: await response.json() }
}

test('the contract names the portal-local route', () => {
  assert.equal(routes.agentLocal.searchFilters, '/api/search-filters')
})

test('a valid query answers 200 with a success envelope of normalised filters', async () => {
  const { response, body } = await call('stars=5,4&maxPrice=1500&currency=AED&limit=50&tenantId=evil')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(body, { success: true, data: { stars: [4, 5], currency: 'AED', maxPriceMinor: 150000, page: 1, limit: 50, offset: 0 } })
})

test('an invalid query answers 400 with an error envelope listing each field', async () => {
  const { response, body } = await call(`limit=5000&currency=AED&maxPrice=9999999&destination=${encodeURIComponent("'; DROP TABLE hotels; --")}`)
  assert.equal(response.status, 400)
  assert.equal(body.success, false)
  assert.equal(body.error.code, 'INVALID_SEARCH_FILTERS')
  assert.deepEqual(body.error.details.map((d) => d.field).sort(), ['destination', 'limit', 'maxPrice'])
  assert.deepEqual(body.meta, { timestamp: '2026-10-26T00:00:00.000Z', path: '/api/search-filters', requestId: 'req-1' })
  assert.doesNotMatch(JSON.stringify(body), /DROP TABLE/)
})
