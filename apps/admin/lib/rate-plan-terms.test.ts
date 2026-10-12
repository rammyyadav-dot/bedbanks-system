import test from 'node:test'
import assert from 'node:assert/strict'
import { dayFromApi, termsFromForm } from './rate-plan-terms'

test('blank fields mean not set, never a default payment type or an invented window', () => {
  assert.deepEqual(termsFromForm({ validFrom: '', validTo: '', paymentType: '' }), { ok: true, terms: { validFrom: null, validTo: null, paymentType: null } })
})
test('a window and payment type pass through', () => {
  assert.deepEqual(termsFromForm({ validFrom: '2026-03-01', validTo: '2026-06-30', paymentType: 'PAY_AT_HOTEL' }), { ok: true, terms: { validFrom: '2026-03-01', validTo: '2026-06-30', paymentType: 'PAY_AT_HOTEL' } })
})
test('an inverted window, a bad date and an unknown payment type are refused before any request', () => {
  assert.equal(termsFromForm({ validFrom: '2026-06-01', validTo: '2026-05-01', paymentType: '' }).ok, false)
  assert.equal(termsFromForm({ validFrom: '1/3/2026', validTo: '', paymentType: '' }).ok, false)
  assert.equal(termsFromForm({ validFrom: '', validTo: '', paymentType: 'DEPOSIT' }).ok, false)
})
test('API instants become calendar days', () => {
  assert.equal(dayFromApi('2026-03-01T00:00:00.000Z'), '2026-03-01')
  assert.equal(dayFromApi(null), '')
})
