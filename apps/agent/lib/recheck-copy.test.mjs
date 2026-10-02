import assert from 'node:assert/strict'
import test from 'node:test'
import { canOpenCheckout, recheckOutcomeMessage, recheckOutcomeTitle } from './recheck-copy.ts'

test('describes fixture recheck outcomes without enabling booking', () => {
  assert.equal(recheckOutcomeTitle('rechecked'), 'Offer rechecked')
  assert.equal(recheckOutcomeMessage('rechecked', false), 'Current price and availability have been verified. Booking activation is not available for this account.')
  assert.equal(recheckOutcomeMessage('rechecked', true), 'Current price and availability have been verified.')
  assert.doesNotMatch(recheckOutcomeMessage('rechecked', true), /Booking activation/)
  assert.equal(recheckOutcomeTitle('price_changed'), 'Price updated')
  assert.match(recheckOutcomeMessage('price_changed', false), /Accept the current price/)
  assert.equal(recheckOutcomeTitle('unavailable'), 'This offer is no longer available')
  assert.match(recheckOutcomeMessage('unavailable', false), /Availability changed/)
  assert.equal(recheckOutcomeTitle('offer_expired'), 'This rate has expired')
  assert.match(recheckOutcomeMessage('offer_expired', false), /Refresh the latest rates/)
  assert.equal(recheckOutcomeTitle('provider_unavailable'), 'Recheck is temporarily unavailable')
  assert.match(recheckOutcomeMessage('provider_unavailable', false), /No inventory was allocated/)
  assert.equal(canOpenCheckout(true, 'rechecked'), true)
  assert.equal(canOpenCheckout(false, 'rechecked'), false)
  for (const status of ['price_changed', 'unavailable', 'offer_expired', 'provider_unavailable', 'mapping_invalid', 'rejected']) {
    assert.equal(canOpenCheckout(true, status), false)
  }
  assert.equal(canOpenCheckout(true, undefined), false)
})
