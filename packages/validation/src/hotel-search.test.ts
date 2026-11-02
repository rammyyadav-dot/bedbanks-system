import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hotelSearchSchema } from './hotel-search.ts'

const valid = {
  destination: 'Dubai',
  checkIn: '2026-12-01',
  checkOut: '2026-12-03',
  rooms: 1,
  adults: 2,
  children: 0,
  childAges: [],
  nationality: 'IN',
  currency: 'AED',
}

test('agent hotel search accepts a stay and refuses a tenant id', () => {
  const parsed = hotelSearchSchema.parse(valid)
  assert.equal(parsed.destination, 'Dubai')
  assert.equal(hotelSearchSchema.safeParse({ ...valid, tenantId: 't1' }).success, false)
  assert.equal(hotelSearchSchema.safeParse({ ...valid, checkOut: '2026-12-01' }).success, false)
  assert.equal(hotelSearchSchema.safeParse({ ...valid, children: 1, childAges: [] }).success, false)
})

test('price filters are integer minor units', () => {
  const parsed = hotelSearchSchema.parse({ ...valid, filters: { minPriceMinor: 10000, maxPriceMinor: 50000 } })
  assert.equal(parsed.filters?.minPriceMinor, 10000)
  assert.equal(hotelSearchSchema.safeParse({ ...valid, filters: { minPriceMinor: 10.5 } }).success, false)
})
