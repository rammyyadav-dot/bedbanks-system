import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRules, penaltySummary, quoteSummary, CANCELLATION_DOCUMENT_ORDER } from './booking-finance-ui'

test('rules become whole days, whole percents or integer minor units, never a float', () => {
  assert.deepEqual(buildRules([{ days: '14', kind: 'percent', value: '50' }, { days: '3', kind: 'fixed', value: '120.50' }], 'AED'), { rules: [{ daysBeforeCheckin: 14, penaltyPercent: 50 }, { daysBeforeCheckin: 3, penaltyMinor: '12050' }] })
  assert.ok('errors' in buildRules([{ days: '1.5', kind: 'percent', value: '10' }], 'AED'))
  assert.ok('errors' in buildRules([{ days: '7', kind: 'percent', value: '101' }], 'AED'))
  assert.ok('errors' in buildRules([{ days: '7', kind: 'percent', value: '12.5' }], 'AED'))
  assert.ok('errors' in buildRules([{ days: '7', kind: 'fixed', value: '1.234' }], 'AED'))
  assert.ok('errors' in buildRules([{ days: '', kind: 'fixed', value: '10' }], 'AED'))
})

test('an undecided penalty and a missing policy are worded as needing a person, never as zero', () => {
  assert.match(penaltySummary({ state: 'NEEDS_DECISION', reason: 'policy_unavailable' }), /not decided/)
  assert.match(quoteSummary({ status: 'needs_decision', reason: 'policy_unavailable', detail: 'x', evaluatedAt: '' }), /person must decide/)
  assert.match(quoteSummary({ status: 'quotable', currency: 'AED', sellMinor: '1', penaltyMinor: '1', refundMinor: '0', ruleDaysBeforeCheckin: null, basis: 'NON_REFUNDABLE', evaluatedAt: '' }), /whole amount would be retained/)
})

test('the credit note is issued after the invoice it refers to', () => {
  assert.ok(CANCELLATION_DOCUMENT_ORDER.indexOf('INVOICE') < CANCELLATION_DOCUMENT_ORDER.indexOf('CREDIT_NOTE'))
})
