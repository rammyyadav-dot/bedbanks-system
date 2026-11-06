import assert from 'node:assert/strict'
import test from 'node:test'
import { supplierDraftFailureCopy, supplierOrganizationFailureCopy, supplierReadFailureCopy, supplierRequestOutcome, supplierWorkspaceFailureCopy } from './request-outcome.ts'

test('tenant and supplier failures stay distinct from a timeout', () => {
  assert.equal(supplierRequestOutcome({ status: 403 }), 'denied')
  assert.equal(supplierRequestOutcome({ status: 404 }), 'not_found')
  assert.equal(supplierRequestOutcome({ status: 504 }), 'timeout')
  assert.equal(supplierRequestOutcome({ status: 503 }), 'unavailable')
  assert.equal(supplierRequestOutcome(new Error('offline')), 'unavailable')
})

test('a denied read names the permission and shows no substitute records', () => {
  const copy = supplierReadFailureCopy('bookings', 'denied')
  assert.match(copy, /do not have permission/)
  assert.match(copy, /this organization/)
  assert.match(copy, /Nothing else is shown/)
})

test('a timed-out read says nothing changed, and a timed-out draft asks for a reload before another save', () => {
  assert.match(supplierReadFailureCopy('contracts', 'timeout'), /nothing was changed/)
  const draft = supplierDraftFailureCopy('timeout')
  assert.match(draft, /timed out after it was sent/)
  assert.match(draft, /Reload the room/)
  assert.match(draft, /could overwrite/)
  assert.equal(supplierDraftFailureCopy('denied'), 'You cannot edit this draft. The note was not changed.')
})

test('workspace and organization switches do not describe a timeout as a missing membership', () => {
  assert.match(supplierWorkspaceFailureCopy('timeout'), /timed out/)
  assert.match(supplierWorkspaceFailureCopy('denied'), /do not have permission/)
  assert.match(supplierOrganizationFailureCopy('timeout'), /was not switched/)
  assert.match(supplierOrganizationFailureCopy('denied'), /not available for this session/)
})
