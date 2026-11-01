import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateCreditRisk, type CreditRiskInput, type CreditRiskPolicy } from './src/credit-risk.ts'

const policy: CreditRiskPolicy = { watchBp: 8000, marginCallBp: 9000, pauseBp: 9500, overdueAfterDays: 7, overdueShareOfLineBp: 5000, refuseAfterDays: 30 }
const base: CreditRiskInput = { balanceMinor: 0n, creditLineMinor: 100000n, pendingMinor: 0n, unpaidMinor: 0n, overdueUnpaidMinor: 0n, daysOverdue: 0 }
const run = (over: Partial<CreditRiskInput>, amount = 0n) => evaluateCreditRisk({ ...base, ...over }, policy, amount)

test('utilisation bands: OK below 80%, WATCH from 80%, MARGIN_CALL from 90%; basis points are exact integers', () => {
  assert.deepEqual([run({}).state, run({}).utilisationBp], ['OK', 0n])
  assert.equal(run({ balanceMinor: -79999n }).state, 'OK')
  assert.equal(run({ balanceMinor: -80000n }).state, 'WATCH')
  assert.equal(run({ balanceMinor: -89999n }).state, 'WATCH')
  assert.equal(run({ balanceMinor: -90000n }).state, 'MARGIN_CALL')
  assert.equal(run({ balanceMinor: -90000n }).utilisationBp, 9000n)
})

test('pending holds count as drawn; prepaid money (a positive balance) draws nothing', () => {
  assert.equal(run({ balanceMinor: -50000n, pendingMinor: 40000n }).state, 'MARGIN_CALL')
  assert.deepEqual([run({ balanceMinor: 250000n }).state, run({ balanceMinor: 250000n }).drawnMinor], ['OK', 0n])
})

test('a new hold that would take the agency to the pause level is refused as PAUSED by UTILISATION; just below it is allowed', () => {
  const r = run({ balanceMinor: -50000n }, 45000n)
  assert.deepEqual([r.state, r.reasons, r.projectedUtilisationBp], ['PAUSED', ['UTILISATION'], 9500n])
  assert.equal(run({ balanceMinor: -50000n }, 44999n).state, 'OK')
  // state reflects what is drawn now: a hold that is only checked, not placed, does not by itself move the agency into MARGIN_CALL
  assert.equal(run({ balanceMinor: -85000n }, 1n).state, 'WATCH')
})

test('the payment that restores the account is the amount that takes it strictly below the watch level', () => {
  const r = run({ balanceMinor: -95000n })
  assert.deepEqual([r.state, r.paymentToRestoreMinor], ['MARGIN_CALL', 15001n])
  assert.equal(run({ balanceMinor: -95000n + 15000n }).state, 'WATCH') // exactly the watch level is still WATCH
  assert.equal(run({ balanceMinor: -95000n + 15001n }).state, 'OK')
  assert.equal(run({ balanceMinor: -80000n }).paymentToRestoreMinor, 0n)
})

test('overdue rules pause regardless of utilisation: 30 days always, and aged unpaid charges at 50% of the line', () => {
  assert.deepEqual([run({ unpaidMinor: 1n, daysOverdue: 29 }).state, run({ unpaidMinor: 1n, daysOverdue: 30 }).reasons], ['OK', ['OVERDUE_DAYS']])
  assert.deepEqual(run({ overdueUnpaidMinor: 49999n, unpaidMinor: 49999n, daysOverdue: 10 }).reasons, [])
  assert.deepEqual(run({ overdueUnpaidMinor: 50000n, unpaidMinor: 50000n, daysOverdue: 10 }).reasons, ['OVERDUE_AMOUNT'])
  assert.deepEqual(run({ overdueUnpaidMinor: 50000n, unpaidMinor: 50000n, daysOverdue: 31 }, 96000n).reasons, ['OVERDUE_DAYS', 'OVERDUE_AMOUNT', 'UTILISATION'])
})

test('a prepaid agency (no credit line) has no utilisation and is paused only by the days rule', () => {
  const r = evaluateCreditRisk({ ...base, creditLineMinor: 0n, balanceMinor: 0n }, policy, 5000n)
  assert.deepEqual([r.state, r.utilisationBp, r.projectedUtilisationBp], ['OK', null, null])
  assert.equal(evaluateCreditRisk({ ...base, creditLineMinor: 0n, unpaidMinor: 100n, daysOverdue: 40 }, policy).state, 'PAUSED')
})

test('invalid policy or negative input is an error, never a pass', () => {
  assert.throws(() => evaluateCreditRisk(base, { ...policy, watchBp: 9500 }))
  assert.throws(() => evaluateCreditRisk(base, { ...policy, pauseBp: 10001 }))
  assert.throws(() => evaluateCreditRisk(base, { ...policy, refuseAfterDays: 3 }))
  assert.throws(() => evaluateCreditRisk({ ...base, pendingMinor: -1n }, policy))
  assert.throws(() => evaluateCreditRisk(base, policy, -1n))
})

test('large amounts do not lose precision (no floating point)', () => {
  const line = 9_007_199_254_740_990_000n
  const r = evaluateCreditRisk({ ...base, creditLineMinor: line, balanceMinor: -(line / 10_000n) * 9_000n }, policy)
  assert.deepEqual([r.state, r.utilisationBp], ['MARGIN_CALL', 9000n])
})
