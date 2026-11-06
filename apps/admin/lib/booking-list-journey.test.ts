import assert from 'node:assert/strict'
import test from 'node:test'
import { dropsBookingAccess, showAgencyFilter } from './booking-list-journey.ts'

test('permission denial, an expired session, and an unreadable source drop the previous booking controls', () => {
  assert.equal(dropsBookingAccess('forbidden'), true)
  assert.equal(dropsBookingAccess('unauthenticated'), true)
  assert.equal(dropsBookingAccess('denied'), true)
  assert.equal(dropsBookingAccess('unreachable'), false)
  assert.equal(dropsBookingAccess('error'), false)
})

test('an agency member never sees the agency filter, including before the first successful list', () => {
  assert.equal(showAgencyFilter(null), false)
  assert.equal(showAgencyFilter({ level: 'AGENCY' }), false)
  assert.equal(showAgencyFilter({ level: 'OPERATOR' }), true)
})
