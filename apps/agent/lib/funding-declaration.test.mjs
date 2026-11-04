import assert from 'node:assert/strict'
import test from 'node:test'
import { fundingDraftError } from './funding-declaration.ts'

const now = Date.parse('2026-11-04T12:00:00.000Z')
const draft = { amount: '10.00', reference: 'REF-1', valueDate: '2026-11-04', payerName: 'Preview Agency' }

test('Given a complete AED declaration, When it matches the server rules, Then the client accepts it', () => {
  assert.equal(fundingDraftError(draft, [], now), null)
})

test('Given a value date, amount, reference or payer outside the server rules, When the draft is checked, Then the client rejects it', () => {
  assert.match(fundingDraftError({ ...draft, amount: '0' }, [], now), /positive/)
  assert.match(fundingDraftError({ ...draft, reference: '' }, [], now), /reference/)
  assert.match(fundingDraftError({ ...draft, payerName: '' }, [], now), /paid/)
  assert.match(fundingDraftError({ ...draft, valueDate: '2026-11-06' }, [], now), /future/)
  assert.match(fundingDraftError({ ...draft, valueDate: '2020-01-01' }, [], now), /year/)
  assert.match(fundingDraftError({ ...draft, currency: 'USD' }, [], now), /AED/)
})

test('Given an existing declaration with the same reference and amount, When the agent tries again, Then the client reports the duplicate', () => {
  const error = fundingDraftError(draft, [{ bankReference: 'ref-1', amountMinor: '1000', currency: 'AED' }], now)
  assert.match(error, /already declared/)
  assert.match(error, /does not credit/)
})
