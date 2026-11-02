import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { domainRoutes, type Money } from './index.ts'

test('Money is integer minor units, not a float amount', () => {
  const money: Money = { amountMinor: 1250, currency: 'AED' }
  assert.equal(money.amountMinor, 1250)
  assert.equal(money.currency, 'AED')
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /amount:\s*number/)
  assert.match(source, /amountMinor/)
})

test('domain routes point at the real NestJS /api/v1 resources', () => {
  assert.equal(domainRoutes.auth.login, '/auth/login')
  assert.equal(domainRoutes.search, '/agent/search')
  assert.equal(domainRoutes.bookings, '/agent/bookings')
  assert.equal(domainRoutes.hotels, '/agent/hotels/:hotelId/images/:imageId/content')
})
