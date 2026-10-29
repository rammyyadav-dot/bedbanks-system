import assert from 'node:assert/strict'
import test from 'node:test'
import { initialsOf, isAwaitingConfirmation, statusLabel, statusTone } from './status'

test('known statuses map to a tone and unknown ones stay neutral', () => {
  assert.equal(statusTone('CONFIRMED'), 'success')
  assert.equal(statusTone('pending supplier'), 'warning')
  assert.equal(statusTone('NO_SHOW'), 'danger')
  assert.equal(statusTone('SOMETHING_NEW'), 'neutral')
})

test('labels read naturally and PENDING_SUPPLIER reads as awaiting confirmation', () => {
  assert.equal(statusLabel('ON_REQUEST'), 'On request')
  assert.equal(statusLabel('PENDING_SUPPLIER'), 'Awaiting confirmation')
  assert.equal(statusLabel('Content Ready'), 'Content ready')
})

test('only pending-supplier and on-request bookings are awaiting confirmation', () => {
  assert.equal(isAwaitingConfirmation('PENDING_SUPPLIER'), true)
  assert.equal(isAwaitingConfirmation('ON_REQUEST'), true)
  assert.equal(isAwaitingConfirmation('CONFIRMED'), false)
})

test('initials use the first two words', () => {
  assert.equal(initialsOf('Grand Hyatt Dubai'), 'GH')
  assert.equal(initialsOf(''), '··')
})
