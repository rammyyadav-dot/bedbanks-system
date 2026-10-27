import test from 'node:test'
import assert from 'node:assert/strict'
import { assertLedgerSign, isLedgerSignValid, availableMinor, canSpend, isOverdrawn, ledgerBalance, positionsByCurrency, refundWithin } from './src/ledger.ts'

test('sign rules: each kind is stored with its own direction and never zero', () => {
  for (const [kind, amount] of [['CREDIT', 5n], ['RELEASE', 5n], ['REFUND', 5n], ['DEBIT', -5n], ['HOLD', -5n]] as const) assertLedgerSign(kind, amount)
  for (const [kind, amount] of [['CREDIT', -5n], ['REFUND', -1n], ['DEBIT', 5n], ['HOLD', 1n]] as const) assert.throws(() => assertLedgerSign(kind, amount))
  for (const kind of ['CREDIT', 'DEBIT', 'HOLD', 'RELEASE', 'REFUND'] as const) assert.throws(() => assertLedgerSign(kind, 0n), /non-zero/)
})

test('sign rules: an adjustment goes either way, a reversal only takes money out, neither is ever zero (ADR 0100)', () => {
  assertLedgerSign('ADJUSTMENT', 5n); assertLedgerSign('ADJUSTMENT', -5n); assertLedgerSign('REVERSAL', -5n)
  assert.throws(() => assertLedgerSign('REVERSAL', 5n), /negative/)
  assert.throws(() => assertLedgerSign('ADJUSTMENT', 0n), /non-zero/)
  assert.throws(() => assertLedgerSign('REVERSAL', 0n), /non-zero/)
  assert.equal(isLedgerSignValid('ADJUSTMENT', -1n), true)
  assert.equal(isLedgerSignValid('REVERSAL', 1n), false)
  assert.equal(isLedgerSignValid('NOPE' as never, 1n), false)
})

test('confirmation pair nets to zero and balance is the plain sum', () => {
  assert.equal(ledgerBalance([-1000n, 1000n, -1000n]), -1000n)
  assert.equal(ledgerBalance([]), 0n)
})

test('available = balance + credit line - pending; spend test is inclusive', () => {
  const a = { balanceMinor: 500n, creditLineMinor: 1000n, pendingMinor: 200n }
  assert.equal(availableMinor(a), 1300n)
  assert.equal(canSpend(a, 1300n), true)
  assert.equal(canSpend(a, 1301n), false)
  assert.equal(canSpend(a, -1n), false)
  assert.equal(availableMinor({ balanceMinor: 1n, creditLineMinor: 2n }), 3n)
})

test('overdrawn only below minus the credit line', () => {
  assert.equal(isOverdrawn({ balanceMinor: -1000n, creditLineMinor: 1000n }), false)
  assert.equal(isOverdrawn({ balanceMinor: -1001n, creditLineMinor: 1000n }), true)
})

test('refund bound', () => {
  assert.equal(refundWithin({ refundMinor: 0n, authorizedRefundableMinor: 10n }), true)
  assert.equal(refundWithin({ refundMinor: 10n, authorizedRefundableMinor: 10n }), true)
  assert.equal(refundWithin({ refundMinor: 11n, authorizedRefundableMinor: 10n }), false)
  assert.equal(refundWithin({ refundMinor: -1n, authorizedRefundableMinor: 10n }), false)
})

test('positions are per currency and never cross-added', () => {
  const rows = positionsByCurrency([
    { currency: 'USD', balanceMinor: 100n, creditLineMinor: 0n },
    { currency: 'AED', balanceMinor: -50n, creditLineMinor: 10n },
    { currency: 'AED', balanceMinor: 20n, creditLineMinor: 0n },
  ])
  assert.deepEqual(rows.map(r => r.currency), ['AED', 'USD'])
  assert.deepEqual(rows[0], { currency: 'AED', accounts: 2, balanceMinor: -30n, creditLineMinor: 10n, availableMinor: -20n, overdrawnAccounts: 1 })
  assert.equal(rows[1].availableMinor, 100n)
})
