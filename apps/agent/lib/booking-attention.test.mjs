import assert from 'node:assert/strict'
import test from 'node:test'
import { agentFacingBooking, supplierReferenceForAgent } from './booking-attention.ts'

test('an uncertain supplier outcome is confirmation pending', () => {
  for (const status of ['UNKNOWN', 'SENDING', 'PREPARED']) {
    const face = agentFacingBooking('PENDING', status)
    assert.equal(face.label, 'Confirmation pending')
    assert.equal(face.attention, true)
    assert.match(face.message, /Do not submit another booking/)
    assert.doesNotMatch(`${face.label} ${face.message}`, /UNKNOWN|FAILED/i)
  }
})

test('pending without an uncertain mutation stays pending', () => {
  assert.equal(agentFacingBooking('PENDING', null).label, 'Pending')
  assert.equal(agentFacingBooking('CONFIRMED', 'ACKNOWLEDGED').label, 'Confirmed')
  assert.equal(agentFacingBooking('CANCELLED', null).label, 'Cancelled')
  assert.equal(agentFacingBooking('FAILED', 'REJECTED').label, 'Not confirmed')
})

test('a supplier reference is shown only after confirmation', () => {
  assert.equal(supplierReferenceForAgent('PENDING', { status: 'UNKNOWN', supplierReference: 'SUP-1' }), null)
  assert.equal(supplierReferenceForAgent('CONFIRMED', { status: 'SENDING', supplierReference: 'SUP-1' }), null)
  assert.equal(supplierReferenceForAgent('CONFIRMED', { status: 'ACKNOWLEDGED', supplierReference: 'SUP-1' }), 'SUP-1')
  assert.equal(supplierReferenceForAgent('CONFIRMED', { status: 'RESOLVED', supplierReference: null }), null)
})
