import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ContractApprovalView } from '@bedbanks/contracts'
import { bpToPercent, contractStage, describeChanges, headerAmendment, headerTermsOf, newContractRequestId, percentToBp } from './contract-lifecycle-ui'

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
  const current = { code: 'C1', validFrom: '2026-11-01', validTo: '2027-10-31', settlementCurrency: 'AED', salesMarkets: ['AE', 'SA'], nationalities: [], ...headerTermsOf({}) }
  assert.deepEqual(headerAmendment(current, { ...current, salesMarkets: ['SA', 'AE'] }), {})
  assert.deepEqual(headerAmendment(current, { ...current, validTo: '2027-12-31', settlementCurrency: 'aed' }), { validTo: '2027-12-31' })
  assert.deepEqual(headerAmendment(current, { ...current, nationalities: ['IN'] }), { nationalities: ['IN'] })
  assert.deepEqual(headerAmendment(current, { ...current, rateType: 'COMMISSIONABLE', commissionBp: 1000, minStayMode: 'ARRIVAL' }), { rateType: 'COMMISSIONABLE', commissionBp: 1000, minStayMode: 'ARRIVAL' })
})

test('header terms read from a contract record with API defaults', () => {
  assert.deepEqual(headerTermsOf({ signedAt: '2026-09-30T00:00:00.000Z', rateType: 'NET' }), { rateType: 'NET', commissionBp: null, paymentTermsDays: null, signedAt: '2026-09-30', signedDocumentRef: null, allotmentType: null, minStayMode: 'STAY_THROUGH', clientBufferDays: 0 })
})

test('changes are described for the approver with the value they replace', () => {
  assert.deepEqual(describeChanges({ validTo: '2027-12-31', salesMarkets: [] }, { validTo: '2027-10-31', salesMarkets: ['AE'] }), ['Valid to: 2027-12-31 (was 2027-10-31)', 'Sales markets: none (was AE)'])
  assert.deepEqual(describeChanges({ cancellationPolicies: [{ policySet: null, daysBeforeCheckin: 3, penaltyPercent: 100, penaltyMinor: null, currency: null }] }), ['Cancellation rules: 1 rule(s)'])
  assert.deepEqual(describeChanges({ header: { minStayMode: 'ARRIVAL' } }, { header: { ...headerTermsOf({}) } } as never), ['Minimum stay reading: ARRIVAL (was STAY_THROUGH)'])
  assert.deepEqual(describeChanges(null), [])
})

test('request ids are unique per press and prefixed', () => {
  assert.equal(newContractRequestId(() => 'x'), 'contract-x')
})

test('commission percent converts to basis points without floats', () => {
  assert.equal(percentToBp('12.5'), 1250); assert.equal(percentToBp('8'), 800); assert.equal(percentToBp('0.05'), 5); assert.equal(percentToBp(''), null)
  assert.equal(percentToBp('12.345'), undefined); assert.equal(percentToBp('abc'), undefined)
  assert.equal(bpToPercent(1250), '12.5'); assert.equal(bpToPercent(800), '8'); assert.equal(bpToPercent(5), '0.05'); assert.equal(bpToPercent(null), '')
})
