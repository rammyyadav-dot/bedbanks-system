import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KANBAN_CARD_LIMIT, KANBAN_STATUSES, kanbanListQuery, kanbanOverflow, kanbanParams, kanbanTitle, readLayout, visibleKanbanStatuses } from './booking-kanban-ui'

test('the board has the spec columns, in the spec order, and only statuses a booking can hold', () => {
  assert.deepEqual([...KANBAN_STATUSES], ['ON_REQUEST', 'PENDING_SUPPLIER', 'CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'FAILED'])
  assert.equal(kanbanTitle('PENDING_SUPPLIER'), 'Pending supplier')
  assert.equal(kanbanTitle('FAILED'), 'Failed')
})

test('a column query keeps the filters, fixes the status, drops chip and paging, and bounds the cards', () => {
  const p = kanbanParams({ chip: 'latest', status: 'CONFIRMED,FAILED', agencyId: 'ag1', from: '2030-06-01', page: 4, pageSize: 100, attention: true }, 'ON_REQUEST')
  assert.equal(p.status, 'ON_REQUEST'); assert.equal(p.pageSize, String(KANBAN_CARD_LIMIT)); assert.equal(p.agencyId, 'ag1'); assert.equal(p.from, '2030-06-01'); assert.equal(p.attention, 'true')
  assert.equal(p.chip, undefined); assert.equal(p.page, undefined)
})

test('work columns show the longest-waiting first; Confirmed shows the soonest check-in; a chosen sort is honoured', () => {
  assert.deepEqual([kanbanParams({}, 'ON_REQUEST').sort, kanbanParams({}, 'ON_REQUEST').dir], ['created', 'asc'])
  assert.deepEqual([kanbanParams({}, 'CONFIRMED').sort, kanbanParams({}, 'CONFIRMED').dir], ['checkIn', 'asc'])
  assert.deepEqual([kanbanParams({ sort: 'amount', dir: 'desc' }, 'FAILED').sort, kanbanParams({ sort: 'amount', dir: 'desc' }, 'FAILED').dir], ['amount', 'desc'])
})

test('a status filter narrows the columns; none shows them all; unknown statuses show none of the board', () => {
  assert.equal(visibleKanbanStatuses({}).length, 6)
  assert.deepEqual([...visibleKanbanStatuses({ status: 'FAILED,CONFIRMED' })], ['CONFIRMED', 'FAILED'])
  assert.deepEqual([...visibleKanbanStatuses({ status: 'CANCELLED' })], [])
})

test('overflow and the list link for a column', () => {
  assert.equal(kanbanOverflow(40, 25), 15); assert.equal(kanbanOverflow(3, 3), 0); assert.equal(kanbanOverflow(2, 5), 0)
  assert.deepEqual(kanbanListQuery({ chip: 'needsAction', agencyId: 'a', page: 3 }, 'FAILED'), { agencyId: 'a', status: 'FAILED' })
})

test('the stored layout is list unless it says kanban', () => {
  assert.equal(readLayout('kanban'), 'kanban'); assert.equal(readLayout('list'), 'list'); assert.equal(readLayout(null), 'list'); assert.equal(readLayout('x'), 'list')
})
