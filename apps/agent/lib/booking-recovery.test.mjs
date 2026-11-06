import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveryLines } from './booking-recovery.ts'

test('an empty recovery run says nothing was old enough', () => {
  assert.deepEqual(recoveryLines([]), ['No interrupted holds were old enough to recover.'])
})

test('a fulfilled booking waiting for confirmation is left in place', () => {
  const lines = recoveryLines([{ holdId: 'hold-a', bookingId: 'booking-a', outcome: 'prebooked_awaiting_confirmation' }])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /booking-a/)
  assert.match(lines[0], /fulfilled supplier booking/)
  assert.match(lines[0], /left in place/)
})

test('an unknown outcome is shown and is not called a success', () => {
  const lines = recoveryLines([{ holdId: 'hold-a', bookingId: null, outcome: 'mystery' }])
  assert.match(lines[0], /Hold hold-a/)
  assert.match(lines[0], /mystery/)
  assert.equal(lines[0].includes('left in place'), false)
})
