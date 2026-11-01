import test from 'node:test'
import assert from 'node:assert/strict'
import { distributionSearchRequestSchema as schema } from '../src/distribution-search.ts'

const valid = {
  checkIn: '2027-03-10',
  checkOut: '2027-03-13',
  destination: { type: 'city', cityId: 'city_dxb' },
  rooms: [{ adults: 2, childAges: [7] }],
  nationality: 'GB',
  currency: 'AED',
}
const issues = (input) => {
  const result = schema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

test('a minimal city search is valid and parses unchanged', () => {
  assert.deepEqual(schema.parse(valid), valid)
})

test('multi-property, geo box, filters, sort and page are accepted', () => {
  const full = {
    ...valid,
    destination: { type: 'geo_box', box: { north: '25.30', south: '25.05', east: '55.45', west: '55.10' } },
    language: 'ar-AE',
    filters: { starRatings: [4, 5], boardBasis: ['BB', 'HB'], refundableOnly: true, maxTotal: { amountMinor: '250000', currency: 'AED' } },
    sort: { by: 'stars', direction: 'desc' },
    page: { size: 50, cursor: 'eyJvIjoyNX0' },
  }
  assert.deepEqual(issues(full), [])
  assert.deepEqual(issues({ ...valid, destination: { type: 'hotels', hotelIds: ['h1', 'h2'] } }), [])
})

test('tenant or agency identity in the body is refused, never silently dropped', () => {
  assert.match(issues({ ...valid, tenantId: 'tenant-b' })[0], /Unrecognized key/)
  assert.match(issues({ ...valid, agencyId: 'agency-b' })[0], /Unrecognized key/)
})

test('dates must be real, ordered and at most 30 nights', () => {
  assert.match(issues({ ...valid, checkIn: '2027-02-30' })[0], /^checkIn: Expected a real calendar date/)
  assert.match(issues({ ...valid, checkOut: valid.checkIn })[0], /^checkOut: checkOut must be after checkIn/)
  assert.match(issues({ ...valid, checkOut: '2027-04-10' })[0], /at most 30 nights/)
  assert.deepEqual(issues({ ...valid, checkOut: '2027-04-09' }), [])
})

test('occupancy limits are enforced', () => {
  assert.notDeepEqual(issues({ ...valid, rooms: [] }), [])
  assert.notDeepEqual(issues({ ...valid, rooms: [{ adults: 0, childAges: [] }] }), [])
  assert.notDeepEqual(issues({ ...valid, rooms: [{ adults: 2, childAges: [18] }] }), [])
  assert.notDeepEqual(issues({ ...valid, rooms: [{ adults: 2, childAges: [1, 2, 3, 4, 5] }] }), [])
  assert.notDeepEqual(issues({ ...valid, rooms: Array(10).fill({ adults: 1, childAges: [] }) }), [])
})

test('money is integer minor units as a string, in the requested currency', () => {
  const withMax = (maxTotal) => ({ ...valid, filters: { maxTotal } })
  assert.notDeepEqual(issues(withMax({ amountMinor: 2500.5, currency: 'AED' })), [])
  assert.notDeepEqual(issues(withMax({ amountMinor: '2500.50', currency: 'AED' })), [])
  assert.notDeepEqual(issues(withMax({ amountMinor: '-1', currency: 'AED' })), [])
  assert.match(issues(withMax({ amountMinor: '250000', currency: 'USD' }))[0], /maxTotal must be in the requested currency/)
})

test('geo boxes must be ordered, in range and not cross the antimeridian', () => {
  const box = (b) => ({ ...valid, destination: { type: 'geo_box', box: b } })
  assert.notDeepEqual(issues(box({ north: '25.0', south: '25.3', east: '55.4', west: '55.1' })), [])
  assert.notDeepEqual(issues(box({ north: '91', south: '25.3', east: '55.4', west: '55.1' })), [])
  assert.notDeepEqual(issues(box({ north: '10', south: '-10', east: '-179', west: '179' })), [])
})

test('hotel lists are bounded and unique', () => {
  assert.notDeepEqual(issues({ ...valid, destination: { type: 'hotels', hotelIds: ['h1', 'h1'] } }), [])
  assert.notDeepEqual(issues({ ...valid, destination: { type: 'hotels', hotelIds: Array.from({ length: 101 }, (_, i) => `h${i}`) } }), [])
})

test('identifiers, cursors and codes reject injection-shaped input', () => {
  assert.notDeepEqual(issues({ ...valid, destination: { type: 'city', cityId: "dxb' OR 1=1" } }), [])
  assert.notDeepEqual(issues({ ...valid, page: { cursor: 'abc\r\nX-Injected: 1' } }), [])
  assert.notDeepEqual(issues({ ...valid, currency: 'aed' }), [])
  assert.notDeepEqual(issues({ ...valid, page: { size: 101 } }), [])
})
