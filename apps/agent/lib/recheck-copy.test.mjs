import assert from 'node:assert/strict'
import test from 'node:test'
import { recheckOutcomeMessage } from './recheck-copy.ts'

test('describes fixture recheck outcomes without enabling booking', () => {
  assert.match(recheckOutcomeMessage('rechecked', false), /Rate rechecked against current contracted inventory/)
  assert.match(recheckOutcomeMessage('rechecked', false), /Booking remains disabled/)
  assert.match(recheckOutcomeMessage('price_changed', false), /until you accept the new total/)
  assert.match(recheckOutcomeMessage('unavailable', false), /no longer available/)
  assert.match(recheckOutcomeMessage('offer_expired', false), /offer expired/i)
})
