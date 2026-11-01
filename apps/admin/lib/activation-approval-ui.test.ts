import test from 'node:test'
import assert from 'node:assert/strict'
import type { RatePlanActivationApproval } from '@bedbanks/contracts'
import { approvalStage, approvalSummary, newRequestId } from './activation-approval-ui'

const base: RatePlanActivationApproval = {
  id: 'a1', ratePlanId: 'p1', status: 'PENDING', requestedById: 'u1', reason: 'r', decidedById: null, decisionReason: null, decidedAt: null, executedAt: null,
  createdAt: '2026-10-12T08:00:00.000Z', boundUpdatedAt: '2026-10-12T07:00:00.000Z', isRequester: true, canDecide: false, canCancel: true, canExecute: false,
}

test('no approval, or a finished one, means a new request is the next step', () => {
  assert.equal(approvalStage(null), 'request')
  for (const status of ['REJECTED', 'CANCELLED', 'EXECUTED'] as const) assert.equal(approvalStage({ ...base, status, canCancel: false }), 'request')
})
test('a pending request shows the requester waiting, and another manager deciding', () => {
  assert.equal(approvalStage(base), 'awaiting-other')
  assert.equal(approvalStage({ ...base, isRequester: false, canDecide: true, canCancel: false }), 'decide')
})
test('an approved request is executed, but only when the server says the user can', () => {
  assert.equal(approvalStage({ ...base, status: 'APPROVED', canExecute: true, canCancel: false }), 'execute')
  assert.equal(approvalStage({ ...base, status: 'APPROVED', canExecute: false, canCancel: false }), 'request')
})
test('request ids are unique per press and carry a prefix', () => {
  assert.match(newRequestId(), /^act-/)
  assert.notEqual(newRequestId(), newRequestId())
  assert.equal(newRequestId(() => 'fixed'), 'act-fixed')
})
test('the summary shows dates only, never people', () => {
  assert.equal(approvalSummary({ ...base, status: 'APPROVED', decidedAt: '2026-10-13T09:00:00.000Z' }), 'approved · requested 2026-10-12 · decided 2026-10-13')
})
