import assert from 'node:assert/strict'
import test from 'node:test'
import { HOTEL_SEARCH_FILTER_LIMITS as L, parseHotelSearchFilters, sanitizeSearchText, toCriteriaFilters } from './hotel-search-filter.schema.ts'
import { criteriaFilters } from '../lib/search-filters.ts'

const fields = (result) => (result.ok ? [] : result.errors.map((e) => e.field))
const bad = (input, field) => {
  const result = parseHotelSearchFilters(input)
  assert.equal(result.ok, false, JSON.stringify(input))
  assert.equal(result.status, 400)
  assert.ok(fields(result).includes(field), `${JSON.stringify(input)} should fail on ${field}, got ${fields(result)}`)
}

test('an empty query is valid and gets pagination defaults', () => {
  const r = parseHotelSearchFilters({})
  assert.deepEqual(r, { ok: true, value: { page: 1, limit: 25, offset: 0 } })
  assert.equal(parseHotelSearchFilters(new URLSearchParams('')).ok, true)
})

test('a full valid query is converted to integer minor units and a zero-based offset', () => {
  const r = parseHotelSearchFilters(new URLSearchParams('minPrice=150&maxPrice=1500.50&currency=aed&stars=5,4,4&latitude=25.2048&longitude=55.2708&radius=10&page=3&limit=50&destination=Dubai%20Marina&hotelName=O%27Neill%20Hotel'))
  assert.equal(r.ok, true)
  assert.deepEqual(r.value, { stars: [4, 5], currency: 'AED', minPriceMinor: 15000, maxPriceMinor: 150050, latitude: 25.2048, longitude: 55.2708, radiusKm: 10, page: 3, limit: 50, offset: 100, destination: 'Dubai Marina', hotelName: "O'Neill Hotel" })
  assert.deepEqual(toCriteriaFilters(r.value), { starRatings: [4, 5], minPriceMinor: 15000, maxPriceMinor: 150050 })
})

test('negative, huge, exponent, hex and non-numeric prices are refused', () => {
  for (const price of ['-5', '-0', '1e9', '0x10', 'Infinity', 'NaN', '1,000', '12abc', '99999999999999999999', '1000000.01', '1000001', '.5', '5.', '1.23456']) bad({ maxPrice: price, currency: 'AED' }, 'maxPrice')
  bad({ minPrice: '-1', currency: 'USD' }, 'minPrice')
  assert.equal(parseHotelSearchFilters({ maxPrice: '1000000', currency: 'USD' }).ok, true)
})

test('price scale follows the currency and a currency is mandatory with a price', () => {
  bad({ maxPrice: '10.5', currency: 'JPY' }, 'maxPrice')
  bad({ maxPrice: '10.5' }, 'currency')
  bad({ maxPrice: '10', currency: 'XXX' }, 'currency')
  bad({ maxPrice: '10', currency: 'dollars' }, 'currency')
  assert.equal(parseHotelSearchFilters({ maxPrice: '10.500', currency: 'KWD' }).value.maxPriceMinor, 10500)
})

test('minPrice above maxPrice is refused', () => {
  bad({ minPrice: '500', maxPrice: '100', currency: 'AED' }, 'maxPrice')
  assert.equal(parseHotelSearchFilters({ minPrice: '100', maxPrice: '100', currency: 'AED' }).ok, true)
})

test('stars accept an array or comma list of 1-5 and refuse anything else', () => {
  assert.deepEqual(parseHotelSearchFilters({ stars: [3, 5, 3] }).value.stars, [3, 5])
  assert.deepEqual(parseHotelSearchFilters({ stars: ['4', '5'] }).value.stars, [4, 5])
  assert.deepEqual(parseHotelSearchFilters({ stars: ' 1 , 2 ' }).value.stars, [1, 2])
  for (const stars of ['0', '6', '-1', '4.5', '4,,5', '4,', 'five', '1e0', '4,6', '1,2,3,4,5,1,2,3,4,5,1', ['9'], [1.5], [{ a: 1 }], '1;DROP TABLE hotels']) bad({ stars }, 'stars')
})

test('coordinates must be in range, well formed and paired; radius needs both and is capped', () => {
  bad({ latitude: '91', longitude: '10' }, 'latitude')
  bad({ latitude: '-90.0000001', longitude: '10' }, 'latitude')
  bad({ latitude: '10', longitude: '181' }, 'longitude')
  bad({ latitude: '10', longitude: '-180.5' }, 'longitude')
  bad({ latitude: 'abc', longitude: '10' }, 'latitude')
  bad({ latitude: '1e1', longitude: '10' }, 'latitude')
  bad({ latitude: '10' }, 'longitude')
  bad({ longitude: '10' }, 'latitude')
  bad({ radius: '5' }, 'radius')
  bad({ latitude: '10', longitude: '10', radius: '0' }, 'radius')
  bad({ latitude: '10', longitude: '10', radius: '-3' }, 'radius')
  bad({ latitude: '10', longitude: '10', radius: String(L.maxRadiusKm + 1) }, 'radius')
  bad({ latitude: '10', longitude: '10', radius: '99999999' }, 'radius')
  assert.equal(parseHotelSearchFilters({ latitude: '-90', longitude: '180', radius: '200' }).ok, true)
})

test('page and limit are positive integers with a capped limit', () => {
  for (const limit of ['0', '-1', '101', '1.5', '10000000', 'abc', '1e2', '0x20']) bad({ limit }, 'limit')
  for (const page of ['0', '-2', '10001', '2.5', '99999999999', 'NaN']) bad({ page }, 'page')
  assert.equal(parseHotelSearchFilters({ limit: '100', page: '10000' }).ok, true)
  assert.equal(parseHotelSearchFilters({ limit: '', page: ' ' }).value.limit, 25)
})

test('repeated scalar parameters are refused, not silently picked', () => {
  const r = parseHotelSearchFilters(new URLSearchParams('limit=10&limit=500'))
  assert.equal(r.ok, false)
  assert.ok(fields(r).includes('limit'))
  bad({ destination: ['a', 'b'] }, 'destination')
})

test('text is normalised: control and invisible characters stripped, whitespace collapsed', () => {
  assert.equal(parseHotelSearchFilters({ destination: '  Dubai\u0000\u0007 \t\n  Marina​‮ ' }).value.destination, 'Dubai Marina')
  assert.equal(parseHotelSearchFilters({ hotelName: 'Ｈｏｔｅｌ' }).value.hotelName, 'Hotel')
  assert.equal(parseHotelSearchFilters({ destination: 'Zürich', hotelName: 'Hôtel d’Angleterre' }).ok, true)
  bad({ destination: '\u0000\u0001' }, 'destination')
})

test('text is length limited', () => {
  assert.equal(parseHotelSearchFilters({ destination: 'a'.repeat(150) }).ok, true)
  bad({ destination: 'a'.repeat(151) }, 'destination')
  bad({ hotelName: 'a'.repeat(1_000_000) }, 'hotelName')
  bad({ hotelName: `${'\u0000'.repeat(700)}x` }, 'hotelName')
})

test('SQL, NoSQL, markup and path injection strings are refused', () => {
  const attacks = ["'; DROP TABLE hotels; --", "' OR '1'='1", '" OR ""="', '1; SELECT pg_sleep(10)', 'a/*x*/b', 'x -- y', '{"$ne": null}', '$where: sleep(100)', '{$gt: ""}', '<script>alert(1)</script>', '`id`', '../../etc/passwd', 'a\\b', 'a=b', 'a|b', 'a%00b', 'a*', 'a[0]', 'x;y']
  for (const attack of attacks) { bad({ destination: attack }, 'destination'); bad({ hotelName: attack }, 'hotelName') }
  assert.equal(sanitizeSearchText("King's Cross (London) & Co.").ok, true)
})

test('tenant and unknown keys are dropped, never trusted', () => {
  const r = parseHotelSearchFilters({ tenantId: 'other-tenant', agencyId: 'a', utm_source: 'x', __proto__: { limit: '5' }, limit: '10' })
  assert.deepEqual(r.value, { page: 1, limit: 10, offset: 0 })
  assert.equal('tenantId' in r.value, false)
})

test('non-object and hostile input yields a 400 result, never a throw', () => {
  for (const input of [null, undefined, 5, 'x', [], () => 1, Symbol('s')]) assert.equal(parseHotelSearchFilters(input).ok, false)
  const hostile = new Proxy({}, { get() { throw new Error('boom') } })
  const r = parseHotelSearchFilters(hostile)
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
})

test('error messages never echo the rejected input', () => {
  const r = parseHotelSearchFilters({ destination: "'; DROP TABLE x; --", maxPrice: '9'.repeat(30), currency: 'AED' })
  assert.doesNotMatch(JSON.stringify(r), /DROP TABLE|9{10}/)
})

test('the filter form applies the same price bounds', () => {
  const draft = { starRatings: [], refundableOnly: false, minPrice: '', maxPrice: '', currency: 'AED', boardBasisIds: [], propertyTypes: [], brands: [] }
  const refused = (patch) => assert.equal(criteriaFilters({ ...draft, ...patch }).ok, false, JSON.stringify(patch))
  refused({ maxPrice: '1000001' })
  refused({ maxPrice: '9007199254740' })
  refused({ minPrice: '-5' })
  refused({ minPrice: '1e9' })
  refused({ minPrice: '10', maxPrice: '2' })
  assert.deepEqual(criteriaFilters({ ...draft, minPrice: '150', maxPrice: '1500' }), { ok: true, filters: { minPriceMinor: 15000, maxPriceMinor: 150000 } })
})
