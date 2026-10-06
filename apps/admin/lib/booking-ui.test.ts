import test from 'node:test'
import assert from 'node:assert/strict'
import { BOOKING_COLUMN_IDS, DEFAULT_BOOKING_COLUMNS, bookingHref, bookingQueryString, deadlineUrgency, effectiveChip, formatInZone, hasFilters, moveColumn, normalizeColumns, readBookingQuery, statusLabel, toggleColumn, withFilters } from './booking-ui'

const q = (s: string) => readBookingQuery(new URLSearchParams(s))

test('an empty URL opens on Needs action; any other filter or chip replaces it', () => {
  assert.equal(effectiveChip(q('')), 'needsAction')
  assert.equal(effectiveChip(q('chip=latest')), 'latest')
  assert.equal(effectiveChip(q('reference=FB-1')), undefined)
  assert.equal(effectiveChip(q('status=FAILED')), undefined)
  assert.equal(effectiveChip(q('page=2')), 'needsAction')
})

test('the URL round-trips: unknown and malformed values are dropped, never forwarded to the API', () => {
  const parsed = q('chip=nonsense&status=ON_REQUEST,PENDING,FAILED&from=2030-13-45x&dateType=booked&pageSize=30&page=-2&agencyId=ag1,unassigned&sort=name&dir=up')
  assert.deepEqual(parsed, { chip: undefined, reference: undefined, guest: undefined, agencyId: 'ag1,unassigned', supplier: undefined, hotel: undefined, status: 'ON_REQUEST,FAILED', supplierStatus: undefined, dateType: undefined, from: undefined, to: undefined, paymentMode: undefined, paymentStatus: undefined, missingSupplierRef: undefined, nonRefundable: undefined, amended: undefined, attention: undefined, sort: undefined, dir: undefined, page: undefined, pageSize: undefined })
  assert.equal(bookingQueryString(q('status=FAILED&chip=failed&page=3&pageSize=50&nonRefundable=true')), '?chip=failed&status=FAILED&nonRefundable=true&page=3&pageSize=50')
  assert.equal(bookingHref({}), '/bookings')
  assert.equal(bookingHref(q('pageSize=25')), '/bookings') // the default page size is not written
})

test('changing a filter returns to page 1; paging alone does not touch the filters', () => {
  const current = q('status=FAILED&page=4')
  assert.equal(withFilters(current, { supplier: 'Global Hotel Supply' }).page, undefined)
  assert.equal(withFilters(current, { supplier: 'Global Hotel Supply' }).status, 'FAILED')
  assert.equal(hasFilters(q('page=4&pageSize=50&chip=failed')), false)
  assert.equal(hasFilters(q('guest=amira')), true)
})

test('times show the hotel zone and its label, never the viewer zone; an unknown zone falls back to UTC', () => {
  const iso = '2030-06-10T20:30:00.000Z'
  assert.match(formatInZone(iso, 'Asia/Dubai'), /11 Jun 2030, 00:30 (GMT\+4|GST)/)
  assert.match(formatInZone(iso, 'Europe/London'), /10 Jun 2030, 21:30 (BST|GMT\+1)/)
  assert.match(formatInZone(iso, null), /10 Jun 2030, 20:30 UTC/)
  assert.match(formatInZone(iso, 'Not/AZone'), /10 Jun 2030, 20:30 UTC/)
  assert.equal(formatInZone(null, 'Asia/Dubai'), '—')
  assert.equal(formatInZone('garbage', 'Asia/Dubai'), '—')
  assert.match(formatInZone(iso, 'Asia/Dubai', { dateOnly: true }), /^11 Jun 2030 /)
})

test('a deadline within 48 hours is soon; a past deadline is passed, not soon; no deadline is none', () => {
  const now = new Date('2030-06-10T10:00:00Z')
  assert.equal(deadlineUrgency('2030-06-12T09:59:00Z', now), 'soon')
  assert.equal(deadlineUrgency('2030-06-12T10:01:00Z', now), 'none')
  assert.equal(deadlineUrgency('2030-06-10T09:59:00Z', now), 'passed')
  assert.equal(deadlineUrgency(null, now), 'none')
})

test('column preferences are validated: unknown and duplicate ids dropped, Booking # first, Actions last and never hidden', () => {
  assert.deepEqual(normalizeColumns(undefined), [...DEFAULT_BOOKING_COLUMNS])
  assert.deepEqual(normalizeColumns('x'), [...DEFAULT_BOOKING_COLUMNS])
  assert.deepEqual(normalizeColumns(['stay', 'nope', 'stay', 'status']), ['reference', 'stay', 'status', 'actions'])
  assert.deepEqual(normalizeColumns(['actions', 'hotel', 'reference']), ['reference', 'hotel', 'actions'])
  assert.deepEqual(normalizeColumns([]), ['reference', 'actions'])
  const cols = [...DEFAULT_BOOKING_COLUMNS]
  assert.deepEqual(toggleColumn(cols, 'reference'), cols)
  assert.deepEqual(toggleColumn(cols, 'actions'), cols)
  assert.ok(!toggleColumn(cols, 'guest').includes('guest'))
  assert.deepEqual(toggleColumn(toggleColumn(cols, 'guest'), 'guest').slice(-1), ['actions'])
})

test('moving a column never displaces Booking # or Actions', () => {
  const cols = normalizeColumns(['status', 'agency', 'stay'])
  assert.deepEqual(moveColumn(cols, 'status', -1), cols)           // would pass Booking #
  assert.deepEqual(moveColumn(cols, 'stay', 1), cols)              // would pass Actions
  assert.deepEqual(moveColumn(cols, 'status', 1), ['reference', 'agency', 'status', 'stay', 'actions'])
  assert.deepEqual(moveColumn(cols, 'reference', 1), cols)
  assert.equal(BOOKING_COLUMN_IDS.length, 11)
})

test('status words are plain', () => {
  assert.equal(statusLabel('PENDING_SUPPLIER'), 'PENDING SUPPLIER')
  assert.equal(statusLabel('CANCEL_REQUESTED'), 'CANCEL REQUESTED')
})
