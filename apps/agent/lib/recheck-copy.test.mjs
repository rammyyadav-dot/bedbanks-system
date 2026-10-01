import assert from 'node:assert/strict'
import test from 'node:test'
import { recheckOutcomeMessage, recheckOutcomeTitle } from './recheck-copy.ts'

test('describes fixture recheck outcomes without enabling booking', () => {
  assert.equal(recheckOutcomeTitle('rechecked'), 'Rate verified')
  assert.match(recheckOutcomeMessage('rechecked', false), /Price and availability confirmed/)
  assert.match(recheckOutcomeMessage('rechecked', false), /Booking activation is not currently available/)
  assert.match(recheckOutcomeMessage('rechecked', true), /Price and availability confirmed\./)
  assert.doesNotMatch(recheckOutcomeMessage('rechecked', true), /Booking activation/)
  assert.equal(recheckOutcomeTitle('price_changed'), 'Price updated')
  assert.match(recheckOutcomeMessage('price_changed', false), /Accept the current price/)
  assert.equal(recheckOutcomeTitle('unavailable'), 'This offer is no longer available')
  assert.match(recheckOutcomeMessage('unavailable', false), /Availability changed/)
  assert.equal(recheckOutcomeTitle('offer_expired'), 'This rate has expired')
  assert.match(recheckOutcomeMessage('offer_expired', false), /Refresh the latest rates/)
})
