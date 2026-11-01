import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BookingAccessView, BookingBulkOperationView } from '@bedbanks/contracts'
import { EMPTY_SELECTION, bulkCapabilities, failedIds, failureSummary, pageSelectionState, resultHeadline, selectionIds, selectionProblem, toggleSelected, togglePage } from './booking-bulk-ui'

const access = (permissions: string[], over: Partial<BookingAccessView> = {}): BookingAccessView => ({ level: 'OPERATOR', canViewNet: false, canViewPii: false, agencyId: null, permissions, manualEntry: false, supplierDispatch: false, opsQueue: true, ...over })

test('capabilities need the bulk capability AND the underlying permission, an operator, and the queue switched on', () => {
  assert.deepEqual(bulkCapabilities(access(['booking.bulk.assign', 'booking.ops.assign'])), ['ASSIGN_OWNER'])
  assert.deepEqual(bulkCapabilities(access(['booking.bulk.assign', 'booking.bulk.acknowledge', 'booking.ops.assign'])), ['ASSIGN_OWNER', 'ACKNOWLEDGE'])
  assert.deepEqual(bulkCapabilities(access(['booking.bulk.assign'])), [])
  assert.deepEqual(bulkCapabilities(access(['booking.ops.assign'])), [])
  assert.deepEqual(bulkCapabilities(access(['booking.bulk.assign', 'booking.ops.assign'], { level: 'AGENCY' })), [])
  assert.deepEqual(bulkCapabilities(access(['booking.bulk.assign', 'booking.ops.assign'], { opsQueue: false })), [])
  assert.deepEqual(bulkCapabilities(null), [])
})

test('selection toggles, selects the page, keeps other pages, and clears', () => {
  let s = toggleSelected(EMPTY_SELECTION, 'a'); assert.deepEqual([...s], ['a'])
  s = toggleSelected(s, 'a'); assert.equal(s.size, 0)
  s = togglePage(toggleSelected(EMPTY_SELECTION, 'z'), ['a', 'b']); assert.deepEqual([...s].sort(), ['a', 'b', 'z'])
  assert.equal(pageSelectionState(s, ['a', 'b']), 'all'); assert.equal(pageSelectionState(s, ['a', 'q']), 'some'); assert.equal(pageSelectionState(s, ['q']), 'none')
  s = togglePage(s, ['a', 'b']); assert.deepEqual([...s], ['z'])
  assert.equal(togglePage(EMPTY_SELECTION, []).size, 0)
})

test('more than 100 is refused, never truncated', () => {
  const big = new Set(Array.from({ length: 101 }, (_, i) => `id${i}`))
  assert.equal(selectionIds(big), null); assert.match(selectionProblem(big) ?? '', /at most 100/)
  assert.equal(selectionIds(new Set(Array.from({ length: 100 }, (_, i) => `id${i}`)))?.length, 100)
  assert.match(selectionProblem(EMPTY_SELECTION) ?? '', /at least one/)
})

const op = (o: Partial<BookingBulkOperationView>): BookingBulkOperationView => ({ id: 'o', action: 'ASSIGN_OWNER', status: 'PARTIAL', requestedCount: 5, processedCount: 5, succeededCount: 3, failedCount: 2, createdAt: '', completedAt: '', replayed: false, failuresByCode: { INVALID_STATE: 1, NOT_FOUND: 1 }, items: [], ...o })

test('a partial result is never worded as success', () => {
  assert.deepEqual(resultHeadline(op({})), { tone: 'warn', text: '3 of 5 updated; 2 could not be.' })
  assert.equal(resultHeadline(op({ status: 'SUCCEEDED', succeededCount: 5, failedCount: 0 })).tone, 'ok')
  assert.equal(resultHeadline(op({ status: 'FAILED', succeededCount: 0, failedCount: 5 })).tone, 'bad')
  assert.equal(resultHeadline(op({ status: 'PROCESSING', succeededCount: 1, failedCount: 1 })).tone, 'warn')
  assert.match(resultHeadline(op({ status: 'SUCCEEDED', requestedCount: 1, succeededCount: 1, failedCount: 0 })).text, /All 1 booking updated/)
})

test('failure reasons are readable and failed ids can be kept selected', () => {
  assert.deepEqual(failureSummary(op({})).map((f) => [f.code, f.count]), [['INVALID_STATE', 1], ['NOT_FOUND', 1]])
  assert.ok(failureSummary(op({})).every((f) => f.label.length > 3))
  assert.deepEqual(failedIds(op({ items: [{ bookingId: 'a', reference: 'FB-1', status: 'SUCCEEDED', errorCode: null }, { bookingId: 'b', reference: null, status: 'FAILED', errorCode: 'NOT_FOUND' }] })), ['b'])
})
