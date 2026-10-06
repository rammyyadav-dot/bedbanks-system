import assert from 'node:assert/strict'
import test from 'node:test'
import { formatRemaining, opsQueryString, priorityTone, readOpsQuery, slaTone, withOpsFilters } from './booking-ops-ui'

test('remaining time is plain words from the API seconds: overdue, due in, and the edges', () => {
  assert.equal(formatRemaining(null), '—'); assert.equal(formatRemaining(0), 'due now')
  assert.equal(formatRemaining(-37 * 60), 'overdue by 37 min'); assert.equal(formatRemaining(-(3600 + 5 * 60)), 'overdue by 1 h 5 min')
  assert.equal(formatRemaining(2 * 3600 + 5 * 60), 'due in 2 h 5 min'); assert.equal(formatRemaining(30), 'due in under a minute'); assert.equal(formatRemaining(-26 * 3600), 'overdue by 1 d 2 h')
})
test('tones: breached and urgent are red, due soon and high are amber, and the word is always shown too', () => {
  assert.equal(slaTone('BREACHED'), 'bad'); assert.equal(slaTone('DUE_SOON'), 'warn'); assert.equal(slaTone('WITHIN_SLA'), 'ok'); assert.equal(slaTone(null), 'neutral')
  assert.equal(priorityTone('CRITICAL'), 'bad'); assert.equal(priorityTone('URGENT'), 'bad'); assert.equal(priorityTone('HIGH'), 'warn'); assert.equal(priorityTone('NORMAL'), 'neutral')
})
test('the URL is the view: it round-trips, drops what the API would refuse, and is identical however it was built', () => {
  const q = readOpsQuery(new URLSearchParams('page=3&tab=mine&priority=URGENT,BOGUS&reason=SUPPLIER_UNKNOWN&sla=BREACHED&checkInFrom=2030-02-31&assignee=me&reference=ab&pageSize=30'))
  assert.deepEqual(q, { tab: 'mine', priority: ['URGENT'], reason: ['SUPPLIER_UNKNOWN'], sla: ['BREACHED'], assignee: 'me', page: 3 })
  assert.equal(opsQueryString(q), '?tab=mine&reason=SUPPLIER_UNKNOWN&priority=URGENT&assignee=me&sla=BREACHED&page=3')
  assert.equal(opsQueryString(readOpsQuery(new URLSearchParams('sla=BREACHED&assignee=me&priority=URGENT&reason=SUPPLIER_UNKNOWN&tab=mine&page=3'))), opsQueryString(q))
  assert.equal(opsQueryString({ tab: 'active', page: 1 }), '')
})
test('changing a filter returns to page 1; changing the page keeps the filters; empty values disappear', () => {
  const base = { tab: 'breached' as const, priority: ['URGENT' as const], page: 4 }
  assert.deepEqual(withOpsFilters(base, { supplier: 'zeta' }), { tab: 'breached', priority: ['URGENT'], supplier: 'zeta' })
  assert.deepEqual(withOpsFilters(base, { page: 5 }), { tab: 'breached', priority: ['URGENT'], page: 5 })
  assert.deepEqual(withOpsFilters(base, { priority: [] }), { tab: 'breached' })
})
