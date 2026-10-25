import test from 'node:test'
import assert from 'node:assert/strict'
import type { BankStatementEntry } from './src/bank-statement.ts'
import { matchBankStatement, type ExpectedPayment } from './src/bank-matching.ts'

const entry = (over: Partial<BankStatementEntry> = {}): BankStatementEntry => ({
  entryRef: 'B1', direction: 'DEBIT', currency: 'AED', amountMinor: 25050n, bookingDate: '2026-10-02', valueDate: '2026-10-02', references: ['PAY-2026-0042'], remittanceInfo: '', ...over,
})
const pay = (id: string, over: Partial<ExpectedPayment> = {}): ExpectedPayment => ({
  id, kind: 'SUPPLIER_SETTLEMENT', reference: 'PAY-2026-0042', currency: 'AED', amountMinor: 25050n, direction: 'DEBIT', date: '2026-10-02', ...over,
})
const period = { from: '2026-10-01', to: '2026-10-31' }
const types = (r: ReturnType<typeof matchBankStatement>) => r.findings.map((f) => [f.key, f.type])

test('exact reference, direction, currency and amount is a clean match; case and punctuation in the reference are ignored', () => {
  const r = matchBankStatement([entry({ references: [], remittanceInfo: 'Payment pay 2026 0042 to Hotelco' })], [pay('s1')], period)
  assert.deepEqual(types(r), [['entry:1', 'MATCHED']])
  assert.deepEqual(r.summary, [{ currency: 'AED', matched: 1, exceptions: 0, matchedMinor: 25050n, unmatchedCreditMinor: 0n, unmatchedDebitMinor: 0n }])
})

test('a reference inside a longer token is not a match (whole tokens only)', () => {
  assert.deepEqual(types(matchBankStatement([entry({ references: [], remittanceInfo: 'XPAY20260042Y' })], [pay('s1')], period)), [['entry:1', 'UNMATCHED_ENTRY'], ['expected:s1', 'EXPECTED_NOT_ON_STATEMENT']])
})

test('amount, currency and direction differences are exceptions; no conversion and no variance across currencies', () => {
  const amount = matchBankStatement([entry({ amountMinor: 25000n })], [pay('s1')], period).findings[0]
  assert.deepEqual([amount.type, amount.varianceMinor], ['AMOUNT_MISMATCH', -50n])
  const cur = matchBankStatement([entry({ currency: 'USD', amountMinor: 6820n })], [pay('s1')], period).findings[0]
  assert.deepEqual([cur.type, cur.varianceMinor, cur.bankMinor, cur.expectedMinor], ['CURRENCY_MISMATCH', null, 6820n, 25050n])
  assert.equal(matchBankStatement([entry({ direction: 'CREDIT' })], [pay('s1')], period).findings[0].type, 'DIRECTION_MISMATCH')
})

test('a payment is matched once: a second movement is a duplicate payment, an identical repeated line is a duplicate entry', () => {
  assert.deepEqual(types(matchBankStatement([entry(), entry({ entryRef: 'B2' })], [pay('s1')], period)), [['entry:1', 'MATCHED'], ['entry:2', 'DUPLICATE_PAYMENT']])
  assert.deepEqual(types(matchBankStatement([entry(), entry()], [pay('s1')], period)), [['entry:1', 'MATCHED'], ['entry:2', 'DUPLICATE_ENTRY']])
})

test('two expected payments sharing a reference are ambiguous, never guessed', () => {
  const r = matchBankStatement([entry()], [pay('s1'), pay('s2', { kind: 'FUNDING_RECEIPT', direction: 'CREDIT' })], period)
  assert.deepEqual(types(r), [['entry:1', 'AMBIGUOUS_REFERENCE']])
})

test('unmatched movements go to suspense by direction; missing payments are reported only inside the period; short references never match', () => {
  const r = matchBankStatement(
    [entry({ references: ['NOPE-1111'], amountMinor: 700n }), entry({ entryRef: 'B3', direction: 'CREDIT', references: ['ZZZ-9999'], amountMinor: 900n })],
    [pay('s1'), pay('old', { date: '2026-09-01' }), pay('short', { reference: 'A1' })],
    period)
  assert.deepEqual(types(r), [['entry:1', 'UNMATCHED_ENTRY'], ['entry:2', 'UNMATCHED_ENTRY'], ['expected:s1', 'EXPECTED_NOT_ON_STATEMENT'], ['expected:short', 'EXPECTED_NOT_ON_STATEMENT']])
  assert.deepEqual([r.summary[0].unmatchedDebitMinor, r.summary[0].unmatchedCreditMinor], [700n, 900n])
})

test('funding receipts match incoming credits', () => {
  const r = matchBankStatement([entry({ direction: 'CREDIT', references: ['AGY-FUND-77'], amountMinor: 120000n })], [pay('r1', { kind: 'FUNDING_RECEIPT', reference: 'AGY-FUND-77', direction: 'CREDIT', amountMinor: 120000n })], period)
  assert.equal(r.findings[0].type, 'MATCHED'); assert.equal(r.findings[0].expectedKind, 'FUNDING_RECEIPT')
})
