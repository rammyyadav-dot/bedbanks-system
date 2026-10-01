import assert from 'node:assert/strict'
import test from 'node:test'
import { priceChangeDisplay, recheckBaselineMinor, recheckResultApplies } from './recheck-attempt.ts'

test('applies a recheck only to the attempt that is still selected', () => {
  const attempt = { generation: 2, offerId: 'offer-a' }
  assert.equal(recheckResultApplies(attempt, { generation: 2, offerId: 'offer-a' }), true)
  assert.equal(recheckResultApplies(attempt, { generation: 3, offerId: 'offer-a' }), false)
  assert.equal(recheckResultApplies(attempt, { generation: 2, offerId: 'offer-b' }), false)
  assert.equal(recheckResultApplies(attempt, { generation: 1, offerId: 'offer-b' }), false)
})

test('an accepted price becomes the next recheck baseline', () => {
  const searchQuoteMinor = 1000
  assert.equal(recheckBaselineMinor(searchQuoteMinor, null), 1000)
  const first = priceChangeDisplay({ searchQuoteMinor, baselineMinor: recheckBaselineMinor(searchQuoteMinor, null), currentMinor: 1100 })
  assert.equal(first.previousMinor, 1000)
  assert.equal(first.currentMinor, 1100)
  assert.equal(first.searchQuoteMinor, null)
  const accepted = 1100
  const second = priceChangeDisplay({ searchQuoteMinor, baselineMinor: recheckBaselineMinor(searchQuoteMinor, accepted), currentMinor: 1150 })
  assert.deepEqual(second, { previousMinor: 1100, currentMinor: 1150, searchQuoteMinor: 1000 })
})
