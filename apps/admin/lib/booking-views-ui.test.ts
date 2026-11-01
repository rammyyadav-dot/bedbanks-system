import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BookingSavedViewView } from '@bedbanks/contracts'
import { currentViewPayload, isModified, viewHref, viewProblem, withView } from './booking-views-ui'
import { readBookingQuery } from './booking-ui'

const q = (qs: string) => readBookingQuery(new URLSearchParams(qs))
const view = (resolution: BookingSavedViewView['resolution']): BookingSavedViewView => ({ id: 'v1', name: 'n', description: null, filterVersion: 1, filters: {}, sort: { sort: 'created', dir: 'desc' }, visibleColumns: null, isDefault: false, version: 1, createdAt: '', updatedAt: '', resolution })

test('saving sends filters without sort or paging, and the sort apart', () => {
  const p = currentViewPayload({ ...q('status=FAILED&sort=amount&dir=asc&page=3&pageSize=50'), chip: 'failed' }, ['reference', 'status', 'actions'])
  assert.deepEqual(p.filters, { chip: 'failed', status: 'FAILED' })
  assert.deepEqual(p.sort, { sort: 'amount', dir: 'asc' })
  assert.deepEqual(p.visibleColumns, ['reference', 'status', 'actions'])
  assert.deepEqual(currentViewPayload(q('chip=checkInNext7'), null).sort, { sort: 'checkIn', dir: 'asc' }) // the chip's own default
  assert.equal(currentViewPayload(q(''), null).visibleColumns, null)
})

test('opening a view resolves to the normal booking URL, with the view id as a UI-only marker', () => {
  const href = viewHref(view({ status: 'ok', params: { status: 'FAILED', sort: 'amount' } }))
  assert.equal(href, '/bookings?status=FAILED&sort=amount&view=v1')
  assert.equal(viewHref(view({ status: 'stale', issues: [] })), null)
  assert.equal(viewHref(view({ status: 'restricted', issues: [] })), null)
  assert.match(viewProblem(view({ status: 'restricted', issues: [] })) ?? '', /no longer have access/)
  assert.match(viewProblem(view({ status: 'stale', issues: [] })) ?? '', /no longer understands/)
  assert.equal(viewProblem(view({ status: 'ok', params: {} })), null)
})

test('a view is modified only when its canonical query differs, not when the same filters are spelled differently', () => {
  const v = view({ status: 'ok', params: { status: 'CONFIRMED,FAILED', supplier: 'X' } })
  assert.equal(isModified(q('supplier=X&status=FAILED,CONFIRMED'), v), false)
  assert.equal(isModified(q('supplier=X&status=FAILED,CONFIRMED&page=4&pageSize=50'), v), false) // paging is not part of a view
  assert.equal(isModified(q('supplier=Y&status=CONFIRMED,FAILED'), v), true)
  assert.equal(isModified(q('supplier=X&status=CONFIRMED,FAILED&sort=amount'), v), true)
  assert.equal(isModified(q('supplier=X'), view({ status: 'stale', issues: [] })), true)
})

test('the active view is carried in the URL, and dropped when there is none', () => {
  assert.equal(withView('/bookings', 'v1'), '/bookings?view=v1')
  assert.equal(withView('/bookings?status=FAILED', 'v 1'), '/bookings?status=FAILED&view=v%201')
  assert.equal(withView('/bookings?status=FAILED', null), '/bookings?status=FAILED')
})
