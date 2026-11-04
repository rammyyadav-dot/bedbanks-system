import assert from 'node:assert/strict'
import test from 'node:test'
import { blocksNewBookingAttempt, cancellationQuoteFresh, holdStillConfirmable, nextHoldKey, shouldWarnBeforeLeave } from './checkout-guard.ts'

test('Given an uncertain prebook or confirmation, When the agent is still on the checkout, Then a new booking attempt is blocked', () => {
  assert.equal(blocksNewBookingAttempt('uncertain'), true)
  assert.equal(blocksNewBookingAttempt('failed'), false)
  assert.equal(shouldWarnBeforeLeave('held'), true)
  assert.equal(shouldWarnBeforeLeave('done'), false)
})

test('Given a definite rejection, When the agent retries a hold, Then a new key is required; an uncertain hold keeps the same key', () => {
  assert.equal(nextHoldKey('hold-1', 'uncertain'), 'hold-1')
  assert.equal(nextHoldKey('hold-1', 'rejected'), null)
})

test('Given an expired hold, When confirmation is attempted, Then it is refused', () => {
  assert.equal(holdStillConfirmable('2000-01-01T00:00:00.000Z', Date.parse('2026-11-04T00:00:00.000Z')), false)
  assert.equal(holdStillConfirmable('2099-01-01T00:00:00.000Z', Date.parse('2026-11-04T00:00:00.000Z')), true)
})

test('Given a cancellation quote older than the freshness window, When cancel is attempted, Then the quote is stale', () => {
  const now = Date.parse('2026-11-04T12:00:00.000Z')
  assert.equal(cancellationQuoteFresh('2026-11-04T11:59:00.000Z', now), true)
  assert.equal(cancellationQuoteFresh('2026-11-04T11:00:00.000Z', now), false)
})
