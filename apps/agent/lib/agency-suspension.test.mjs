import assert from 'node:assert/strict'
import test from 'node:test'
import { agencySuspendedMessage, agencySuspendedTitle, isAgencySuspended } from './agency-suspension.mjs'

test('recognises only the agency-suspended refusal', () => {
  assert.equal(isAgencySuspended({ success: false, error: { code: 'AGENCY_SUSPENDED', message: 'x' } }), true)
  assert.equal(isAgencySuspended({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } }), false)
  assert.equal(isAgencySuspended({ error: {} }), false)
  assert.equal(isAgencySuspended(null), false)
  assert.equal(isAgencySuspended('AGENCY_SUSPENDED'), false)
})

test('the copy says what is blocked and who to contact, and is not a retry prompt', () => {
  assert.equal(agencySuspendedTitle, 'Your agency is suspended')
  assert.match(agencySuspendedMessage, /searches and bookings are blocked/)
  assert.match(agencySuspendedMessage, /Contact your account manager/)
  assert.doesNotMatch(agencySuspendedMessage, /try again/i)
})
