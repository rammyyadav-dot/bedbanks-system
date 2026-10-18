import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContractApprovalView } from '@bedbanks/contracts'
import { contractStage, describeChanges, headerAmendment, newContractRequestId } from './contract-lifecycle-ui'

const approval = (over: Partial<ContractApprovalView>): ContractApprovalView => ({
  id: 'a1', contractId: 'c1', kind: 'ACTIVATE', status: 'PENDING', reason: 'r', requestedById: 'u1', decidedById: null, decisionReason: null, decidedAt: null, executedAt: null,
  createdAt: '2026-10-17T00:00:00.000Z', changes: null, changedSinceRequest: false, isRequester: true, canDecide: false, canCancel: true, canExecute: false, ...over,
})

test('stage follows the server flags for the signed-in user', () => {
  assert.equal(contractStage(null), 'none')
  assert.equal(contractStage(approval({})), 'awaiting-other')
  assert.equal(contractStage(approval({ isRequester: false, canDecide: true })), 'decide')
  assert.equal(contractStage(approval({ status: 'APPROVED', canExecute: true })), 'execute')
  assert.equal(contractStage(approval({ status: 'REJECTED' })), 'none')
})

test('an amendment carries only the header terms that changed', () => {
  const current = { code: 'C1', validFrom: '2026-11-01', validTo: '2027-10-31', settlementCurrency: 'AED', salesMarkets: ['AE', 'SA'], nationalities: [] }
  assert.deepEqual(headerAmendment(current, { ...current, salesMarkets: ['SA', 'AE'] }), {})
  assert.deepEqual(headerAmendment(current, { ...current, validTo: '2027-12-31', settlementCurrency: 'aed' }), { validTo: '2027-12-31' })
  assert.deepEqual(headerAmendment(current, { ...current, nationalities: ['IN'] }), { nationalities: ['IN'] })
})

test('changes are described for the approver with the value they replace', () => {
  assert.deepEqual(describeChanges({ validTo: '2027-12-31', salesMarkets: [] }, { validTo: '2027-10-31', salesMarkets: ['AE'] }), ['Valid to: 2027-12-31 (was 2027-10-31)', 'Sales markets: none (was AE)'])
  assert.deepEqual(describeChanges({ cancellationPolicies: [{ policySet: null, daysBeforeCheckin: 3, penaltyPercent: 100, penaltyMinor: null, currency: null }] }), ['Cancellation rules: 1 rule(s)'])
  assert.deepEqual(describeChanges(null), [])
})

test('request ids are unique per press and prefixed', () => {
  assert.equal(newContractRequestId(() => 'x'), 'contract-x')
})
