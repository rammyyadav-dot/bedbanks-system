import assert from 'node:assert/strict'
import test from 'node:test'
import { creditRefusal } from './agency-credit.mjs'

test('recognises the three credit refusals and says what happened without amounts', () => {
  for (const code of ['AGENCY_CREDIT_LIMIT_EXCEEDED', 'AGENCY_CREDIT_CURRENCY_MISMATCH', 'AGENCY_CREDIT_UNAVAILABLE']) {
    const r = creditRefusal({ success: false, error: { code, message: 'x', details: { availableMinor: '40000' } } })
    assert.equal(r?.code, code); assert.doesNotMatch(r.message, /\d{3,}/)
  }
  assert.equal(creditRefusal({ error: { code: 'AGENCY_CREDIT_UNAVAILABLE' } }).retryable, true)
  assert.equal(creditRefusal({ error: { code: 'AGENCY_CREDIT_LIMIT_EXCEEDED' } }).retryable, false)
})

test('any other error is not a credit refusal', () => {
  for (const body of [null, 'x', {}, { error: {} }, { error: { code: 'FORBIDDEN' } }, { error: { code: 'AGENCY_SUSPENDED' } }]) assert.equal(creditRefusal(body), null)
})
