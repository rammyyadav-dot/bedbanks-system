import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BookingAccessView } from '@bedbanks/contracts'
import { canExport, exportBlockedReason, exportDoneNote, exportParams, exportTooLarge } from './booking-export-ui'

const access = (permissions: string[], over: Partial<BookingAccessView> = {}): BookingAccessView => ({ level: 'OPERATOR', canViewNet: false, canViewPii: false, agencyId: null, permissions, manualEntry: false, supplierDispatch: false, opsQueue: false, ...over })

test('export needs the permission that matches the caller level; no access means no control', () => {
  assert.equal(canExport(access(['booking.export'])), true)
  assert.equal(canExport(access(['booking.export.agency'])), false)
  assert.equal(canExport(access(['booking.export.agency'], { level: 'AGENCY', agencyId: 'a1' })), true)
  assert.equal(canExport(access(['booking.export'], { level: 'AGENCY', agencyId: 'a1' })), false)
  assert.equal(canExport(access(['booking.read'])), false)
  assert.equal(canExport(null), false)
})

test('an export sends the filters but never the page, the page size or the unexportable flag filter', () => {
  const params = exportParams({ chip: 'latest', status: 'CONFIRMED,FAILED', from: '2030-06-01', to: '2030-06-30', dateType: 'checkIn', page: 3, pageSize: 100, attention: true })
  assert.deepEqual(params, { chip: 'latest', status: 'CONFIRMED,FAILED', dateType: 'checkIn', from: '2030-06-01', to: '2030-06-30' })
  assert.deepEqual(exportParams({}), {})
})

test('the limit is explained before the click, and a flag-filtered list says why it cannot be exported', () => {
  assert.equal(exportTooLarge(1000), false)
  assert.equal(exportTooLarge(1001), true)
  assert.equal(exportTooLarge(null), false)
  assert.match(exportBlockedReason({}, 1500) ?? '', /1,500 bookings match; an export carries at most 1,000/)
  assert.match(exportBlockedReason({ attention: true }, 5) ?? '', /reconciliation-flag/)
  assert.equal(exportBlockedReason({}, 10), null)
})

test('the confirmation says it was audited and handles one row', () => {
  assert.match(exportDoneNote('1', 'req-1'), /Exported 1 booking to CSV.*audit log.*Request req-1/)
  assert.match(exportDoneNote('12', null), /Exported 12 bookings/)
})
