import test from 'node:test'
import assert from 'node:assert/strict'
import { amountAtStake, isException, needsSecondApproval, reconcileStatement, secondApprovalThresholdMinor, type LedgerItemInput, type StatementLineInput } from './src/reconciliation.ts'

const item = (bookingId: string, refs: string[], over: Partial<LedgerItemInput> = {}): LedgerItemInput =>
  ({ bookingId, references: refs, currency: 'AED', netMinor: 10000n, state: 'PAYABLE', expectedCreditMinor: null, previouslyInvoiced: false, ...over })
const line = (lineId: string, reference: string, over: Partial<StatementLineInput> = {}): StatementLineInput =>
  ({ lineId, reference, kind: 'CHARGE', currency: 'AED', amountMinor: 10000n, ...over })
const exact = { roundingToleranceMinor: 0n }
const typeOf = (result: ReturnType<typeof reconcileStatement>, key: string) => result.findings.find((f) => f.key === key)?.type

test('reference and net amount exact is a clean match, on either quoted reference, ignoring case and padding', () => {
  const r = reconcileStatement([line('l1', ' bk-1 '), line('l2', 'sup-9', { amountMinor: 5000n })], [item('b1', ['BK-1', 'SUP-1']), item('b2', ['BK-2', 'SUP-9'], { netMinor: 5000n })], exact)
  assert.deepEqual(r.findings.map((f) => [f.key, f.type, f.rule, f.bookingId, f.varianceMinor]), [['l1', 'MATCHED', 'REFERENCE_AND_NET_EXACT', 'b1', 0n], ['l2', 'MATCHED', 'REFERENCE_AND_NET_EXACT', 'b2', 0n]])
})

test('same-currency variances: within tolerance is rounding, beyond it is an over or under charge, signed statement minus ledger', () => {
  const policy = { roundingToleranceMinor: 1n }
  const r = reconcileStatement(
    [line('a', 'B1', { amountMinor: 10001n }), line('b', 'B2', { amountMinor: 9999n }), line('c', 'B3', { amountMinor: 10500n }), line('d', 'B4', { amountMinor: 9000n })],
    [item('b1', ['B1']), item('b2', ['B2']), item('b3', ['B3']), item('b4', ['B4'])], policy)
  assert.deepEqual(r.findings.map((f) => [f.type, f.varianceMinor]), [['ROUNDING_VARIANCE', 1n], ['ROUNDING_VARIANCE', -1n], ['AMOUNT_OVERCHARGE', 500n], ['AMOUNT_UNDERCHARGE', -1000n]])
  assert.equal(typeOf(reconcileStatement([line('a', 'B1', { amountMinor: 10001n })], [item('b1', ['B1'])], exact), 'a'), 'AMOUNT_OVERCHARGE')
})

test('a different currency is never converted: it is an exception with no variance', () => {
  const r = reconcileStatement([line('a', 'B1', { currency: 'USD', amountMinor: 2723n })], [item('b1', ['B1'])], exact)
  assert.deepEqual([r.findings[0].type, r.findings[0].varianceMinor, r.findings[0].statementMinor, r.findings[0].ledgerMinor], ['CURRENCY_MISMATCH', null, 2723n, 10000n])
  assert.deepEqual(r.settlement.map((s) => [s.currency, s.chargesMinor]), [['USD', 2723n]])
})

test('unknown net is an exception, never a zero comparison', () => {
  assert.equal(typeOf(reconcileStatement([line('a', 'B1')], [item('b1', ['B1'], { netMinor: null })], exact), 'a'), 'NET_UNKNOWN')
  assert.equal(typeOf(reconcileStatement([line('a', 'B1', { amountMinor: 1n })], [item('b1', ['B1'], { netMinor: 0n })], exact), 'a'), 'AMOUNT_OVERCHARGE')
})

test('a surcharge is never auto-matched, even when the reference exists', () => {
  const r = reconcileStatement([line('a', 'B1', { kind: 'SURCHARGE', amountMinor: 1500n })], [item('b1', ['B1'])], exact)
  assert.equal(r.findings[0].type, 'UNINVOICED_SURCHARGE')
  assert.equal(r.findings[0].bookingId, 'b1')
})

test('unmatched, ambiguous and duplicate lines', () => {
  const r = reconcileStatement([line('a', 'NOPE'), line('b', 'SHARED'), line('c', 'B1'), line('d', 'b1')], [item('b1', ['B1']), item('x', ['SHARED']), item('y', ['SHARED'])], exact)
  assert.deepEqual(r.findings.filter((f) => f.lineId).map((f) => f.type), ['UNMATCHED_LINE', 'AMBIGUOUS_REFERENCE', 'MATCHED', 'DUPLICATE_LINE'])
})

test('charge on a cancelled booking; credit settlement against a cancellation', () => {
  const cancelled = item('c1', ['C1'], { state: 'CANCELLED', expectedCreditMinor: 8000n })
  assert.equal(typeOf(reconcileStatement([line('a', 'C1')], [cancelled], exact), 'a'), 'CHARGE_ON_CANCELLED')
  const credit = (amountMinor: bigint) => reconcileStatement([line('a', 'C1', { kind: 'CREDIT', amountMinor })], [cancelled], exact)
  assert.equal(typeOf(credit(8000n), 'a'), 'CREDIT_MATCHED')
  assert.equal(credit(7000n).findings[0].varianceMinor, -1000n)
  assert.equal(typeOf(credit(7000n), 'a'), 'CREDIT_VARIANCE')
  assert.equal(typeOf(reconcileStatement([line('a', 'C1', { kind: 'CREDIT' })], [item('c1', ['C1'])], exact), 'a'), 'CREDIT_WITHOUT_CANCELLATION')
  assert.equal(typeOf(reconcileStatement([line('a', 'C1', { kind: 'CREDIT' })], [item('c1', ['C1'], { state: 'CANCELLED' })], exact), 'a'), 'CREDIT_AMOUNT_UNKNOWN')
})

test('ledger-side findings: payable not on the statement, expected credit not received (only for a booking already invoiced)', () => {
  const r = reconcileStatement([line('a', 'B1')], [item('b1', ['B1']), item('b2', ['B2']), item('b3', ['B3'], { netMinor: null }), item('c1', ['C1'], { state: 'CANCELLED', expectedCreditMinor: 8000n, previouslyInvoiced: true }), item('c2', ['C2'], { state: 'CANCELLED', expectedCreditMinor: 0n, previouslyInvoiced: true }), item('c3', ['C3'], { state: 'CANCELLED', expectedCreditMinor: 5000n })], exact)
  assert.deepEqual(r.findings.filter((f) => !f.lineId).map((f) => [f.key, f.type, f.ledgerMinor]), [['ledger:b2:MISSING_FROM_STATEMENT', 'MISSING_FROM_STATEMENT', 10000n], ['ledger:c1:CREDIT_NOT_RECEIVED', 'CREDIT_NOT_RECEIVED', 8000n]])
})

test('settlement is per currency and never adds currencies; exceptions are counted apart from clean matches', () => {
  const r = reconcileStatement(
    [line('a', 'B1'), line('b', 'B2', { amountMinor: 12000n }), line('c', 'C1', { kind: 'CREDIT', amountMinor: 8000n }), line('d', 'U1', { currency: 'USD', amountMinor: 500n })],
    [item('b1', ['B1']), item('b2', ['B2']), item('c1', ['C1'], { state: 'CANCELLED', expectedCreditMinor: 8000n })], exact)
  assert.deepEqual(r.settlement.map((s) => [s.currency, s.chargesMinor, s.creditsMinor, s.statementNetMinor, s.matchedMinor, s.exceptionMinor]), [['AED', 22000n, 8000n, 14000n, 18000n, 12000n], ['USD', 500n, 0n, 500n, 0n, 500n]])
})

test('deterministic and refuses a non-positive line amount or negative tolerance', () => {
  const inputs = [[line('a', 'B1'), line('b', 'B2')], [item('b1', ['B1']), item('b2', ['B2'])]] as const
  assert.deepEqual(reconcileStatement(inputs[0], inputs[1], exact), reconcileStatement(inputs[0], inputs[1], exact))
  assert.throws(() => reconcileStatement([line('a', 'B1', { amountMinor: 0n })], [], exact), /positive/)
  assert.throws(() => reconcileStatement([], [], { roundingToleranceMinor: -1n }), /negative/)
})

test('second approval: 100 currency units whatever the exponent; disputes never need it; unknown amount always does', () => {
  assert.equal(secondApprovalThresholdMinor('AED'), 10000n)
  assert.equal(secondApprovalThresholdMinor('JPY'), 100n)
  assert.equal(secondApprovalThresholdMinor('KWD'), 100000n)
  const f = { currency: 'AED', varianceMinor: 9999n as bigint | null, statementMinor: 1n as bigint | null, ledgerMinor: null }
  assert.equal(needsSecondApproval('WRITE_OFF_VARIANCE', f), false)
  assert.equal(needsSecondApproval('WRITE_OFF_VARIANCE', { ...f, varianceMinor: -10000n }), true)
  assert.equal(needsSecondApproval('KEEP_LEDGER_AND_DISPUTE', { ...f, varianceMinor: 999999n }), false)
  assert.equal(needsSecondApproval('ACCEPT_STATEMENT', { ...f, varianceMinor: null, statementMinor: null }), true)
  // rejecting a line refuses the whole statement amount, not just the variance
  assert.equal(needsSecondApproval('REJECT_STATEMENT_LINE', { ...f, varianceMinor: 1n, statementMinor: 10000n }), true)
  assert.equal(needsSecondApproval('REJECT_STATEMENT_LINE', { ...f, varianceMinor: 1n, statementMinor: 9999n }), false)
  assert.equal(amountAtStake({ varianceMinor: -5n, statementMinor: 1n, ledgerMinor: 2n }), 5n)
  assert.equal(isException('MATCHED'), false)
  assert.equal(isException('MISSING_FROM_STATEMENT'), true)
})
