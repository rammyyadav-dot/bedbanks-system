import assert from 'node:assert/strict'
import test from 'node:test'
import { initialsOf, needsSupplierAnswer, statusLabel, statusTone } from './status'

test('known statuses map to a tone and unknown ones stay neutral', () => {
  assert.equal(statusTone('CONFIRMED'), 'success')
  assert.equal(statusTone('pending supplier'), 'warning')
  assert.equal(statusTone('NO_SHOW'), 'danger')
  assert.equal(statusTone('SOMETHING_NEW'), 'neutral')
})

test('labels read naturally and PENDING_SUPPLIER reads from the supplier side', () => {
  assert.equal(statusLabel('ON_REQUEST'), 'On request')
  assert.equal(statusLabel('PENDING_SUPPLIER'), 'Awaiting your answer')
  assert.equal(statusLabel('Content Ready'), 'Content ready')
})

test('only pending-supplier and on-request bookings need an answer', () => {
  assert.equal(needsSupplierAnswer('PENDING_SUPPLIER'), true)
  assert.equal(needsSupplierAnswer('ON_REQUEST'), true)
  assert.equal(needsSupplierAnswer('CONFIRMED'), false)
})

test('initials use the first two words', () => {
  assert.equal(initialsOf('Grand Hyatt Dubai'), 'GH')
  assert.equal(initialsOf(''), '··')
})
