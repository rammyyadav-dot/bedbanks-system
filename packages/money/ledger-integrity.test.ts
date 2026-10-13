import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBookingLedger, integrityStatus, type BookingLedgerFacts } from './src/ledger-integrity.ts'

const none: BookingLedgerFacts = { currencies: ['AED'], holdMinor: 0n, holdCount: 0, releaseMinor: 0n, releaseCount: 0, debitMinor: 0n, debitCount: 0, refundMinor: 0n, refundCount: 0, oldestHoldAgeHours: null }
const codes = (f: Partial<BookingLedgerFacts>) => evaluateBookingLedger({ ...none, ...f }).map(x => x.code)

test('every healthy lifecycle state passes', () => {
  assert.deepEqual(codes({}), [])
  assert.deepEqual(codes({ holdMinor: 1000n, holdCount: 1, oldestHoldAgeHours: 1 }), [])
  assert.deepEqual(codes({ holdMinor: 1000n, holdCount: 1, releaseMinor: 1000n, releaseCount: 1 }), [])
  const confirmed = { holdMinor: 1000n, holdCount: 1, releaseMinor: 1000n, releaseCount: 1, debitMinor: 1000n, debitCount: 1 }
  assert.deepEqual(codes(confirmed), [])
  assert.deepEqual(codes({ ...confirmed, refundMinor: 1000n, refundCount: 1 }), [])
  assert.deepEqual(codes({ ...confirmed, refundMinor: 400n, refundCount: 1 }), [])
})

test('each broken rule is named', () => {
  assert.deepEqual(codes({ currencies: ['AED', 'USD'] }), ['MIXED_CURRENCY'])
  assert.deepEqual(codes({ holdMinor: 2000n, holdCount: 2 }), ['DUPLICATE_HOLD'])
  assert.deepEqual(codes({ releaseMinor: 1n, releaseCount: 1 }), ['RELEASE_EXCEEDS_HOLD'])
  assert.deepEqual(codes({ holdMinor: 1000n, holdCount: 1, releaseMinor: 1000n, releaseCount: 1, debitMinor: 900n, debitCount: 1 }), ['SETTLEMENT_MISMATCH'])
  assert.deepEqual(codes({ holdMinor: 1000n, holdCount: 1, releaseMinor: 1000n, releaseCount: 1, debitMinor: 1000n, debitCount: 2 }), ['DUPLICATE_DEBIT'])
  assert.deepEqual(codes({ holdMinor: 1000n, holdCount: 1, releaseMinor: 1000n, releaseCount: 1, debitMinor: 1000n, debitCount: 1, refundMinor: 1001n, refundCount: 1 }), ['REFUND_EXCEEDS_CHARGE'])
  assert.deepEqual(codes({ refundMinor: 5n, refundCount: 2 }), ['DUPLICATE_REFUND', 'REFUND_EXCEEDS_CHARGE'])
})

test('a stale hold is a warning only after 24 hours and only while nothing settled it', () => {
  const held = { holdMinor: 1000n, holdCount: 1 }
  assert.deepEqual(evaluateBookingLedger({ ...none, ...held, oldestHoldAgeHours: 24 }), [{ code: 'STALE_AUTHORIZATION', severity: 'WARNING' }])
  assert.deepEqual(codes({ ...held, oldestHoldAgeHours: 23 }), [])
  assert.deepEqual(codes({ ...held, releaseMinor: 1000n, releaseCount: 1, oldestHoldAgeHours: 500 }), [])
})

test('verdict: errors fail, warnings warn, otherwise pass', () => {
  assert.equal(integrityStatus({ errors: 1, warnings: 5 }), 'FAIL')
  assert.equal(integrityStatus({ errors: 0, warnings: 1 }), 'WARN')
  assert.equal(integrityStatus({ errors: 0, warnings: 0 }), 'PASS')
})
