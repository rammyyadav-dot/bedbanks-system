import assert from 'node:assert/strict'
import test from 'node:test'
import { availableActions, type BookingAvailableAction } from '@bedbanks/contracts'
import { ApiResponseError } from './api/errors'
import { buildActionRequest, buildManualRequest, describeActionError, emptyActionForm, emptyManualForm, visibleFields } from './booking-actions-ui'

const act = (id: string, over: Partial<BookingAvailableAction> = {}): BookingAvailableAction => {
  const base = availableActions({ status: id === 'confirmOnRequest' ? 'ON_REQUEST' : id === 'approveAmendment' ? 'AMEND_REQUESTED' : 'CONFIRMED', closedAt: null, isRefundable: false, checkIn: '2030-07-01' }, 'OPERATOR', new Set(['booking.on-request.resolve', 'booking.cancel.nonrefundable', 'booking.amend']), new Date('2030-06-01T00:00:00Z')).find((a) => a.action === id)
  assert.ok(base, id); return { ...base, ...over }
}

test('an action cannot be built until its required fields are filled, and nothing empty is sent', () => {
  const a = act('confirmOnRequest')
  const none = buildActionRequest(a, 'ON_REQUEST', emptyActionForm()); assert.deepEqual('missing' in none ? none.missing : null, ['supplierRef', 'hotelConfirmationNo'])
  const ok = buildActionRequest(a, 'ON_REQUEST', { ...emptyActionForm(), supplierRef: ' S-1 ', hotelConfirmationNo: 'H-1' })
  assert.deepEqual('request' in ok && ok.request, { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 'S-1', hotelConfirmationNo: 'H-1' })
})

test('a non-refundable cancellation demands the second confirmation and sends it', () => {
  const a = act('requestCancellation'); assert.equal(a.needsSecondConfirmation, true)
  const form = { ...emptyActionForm(), reason: 'Guest cancelled' }
  const need = buildActionRequest(a, 'CONFIRMED', form); assert.deepEqual('missing' in need ? need.missing : null, ['confirmNonRefundable'])
  const ok = buildActionRequest(a, 'CONFIRMED', { ...form, confirmNonRefundable: true })
  assert.deepEqual('request' in ok && ok.request, { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest cancelled', confirmNonRefundable: true })
})

test('optional fields are offered, required ones are marked, and the form never invents a field', () => {
  assert.deepEqual(visibleFields(act('approveAmendment')), ['reason'])
  assert.deepEqual(visibleFields(act('confirmOnRequest')), ['supplierRef', 'hotelConfirmationNo'])
})

test('errors are explained in plain words, a stale view asks for a reload, and a timeout says the outcome is unknown', () => {
  const stale = describeActionError(new ApiResponseError('STALE_STATUS', 'x', 409, 'req-1'))
  assert.match(stale.message, /changed while you were working/); assert.equal(stale.reload, true); assert.equal(stale.requestId, 'req-1')
  assert.match(describeActionError(new ApiResponseError('API_TIMEOUT', 'x', 504)).message, /may already have been applied/)
  assert.match(describeActionError(new ApiResponseError('INTERNAL_SERVER_ERROR', 'stack trace here', 500)).message, /Reload the booking/)
  assert.doesNotMatch(describeActionError(new ApiResponseError('INTERNAL_SERVER_ERROR', 'stack trace here', 500)).message, /stack trace/)
  assert.equal(describeActionError(new ApiResponseError('INTERNAL_SERVER_ERROR', 'x', 500)).reload, true)
  assert.equal(describeActionError(new ApiResponseError('NETWORK_ERROR', 'x', 0)).reload, true)
  assert.match(describeActionError(new Error('connection lost')).message, /outcome could not be verified/)
  assert.equal(describeActionError(new Error('connection lost')).reload, true)
})

test('manual entry: money is converted to integer minor units with no floating point, and bad input is reported per field', () => {
  const f = { ...emptyManualForm('AED'), agencyId: 'a', hotelId: 'h', supplier: 'Supplier One', checkIn: '2030-07-01', checkOut: '2030-07-04', sell: '2500.50', net: '2000',
    rooms: [{ roomName: 'Deluxe', boardCode: 'BB', adults: '2', children: '1', childAges: '6' }], guests: [{ title: '', firstName: 'Amira', lastName: 'Haddad', isLead: true }] }
  const ok = buildManualRequest(f); assert.ok('request' in ok)
  if ('request' in ok) { assert.equal(ok.request.sellMinor, '250050'); assert.equal(ok.request.netMinor, '200000'); assert.deepEqual(ok.request.rooms[0].childAges, [6]) }
  const bad = buildManualRequest({ ...f, sell: '12.345', checkOut: '2030-07-01', rooms: [{ ...f.rooms[0], childAges: '' }], guests: [{ ...f.guests[0], isLead: false }] })
  assert.ok('errors' in bad); if ('errors' in bad) assert.deepEqual(Object.keys(bad.errors).sort(), ['checkOut', 'guests', 'rooms.0.childAges', 'sell'].sort())
})
