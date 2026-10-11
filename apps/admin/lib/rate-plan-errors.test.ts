import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiResponseError } from './api/errors'
import { describeRatePlanActionError } from './rate-plan-errors'

const err = (code: string, status: number, message = 'server message', requestId: string | null = 'req-1') => new ApiResponseError(code, message, status, requestId)

test('a strict-role refusal is explained as the environment, not as missing user permission', () => {
  const clone = describeRatePlanActionError(err('RUNTIME_ROLE_OPERATION_PROHIBITED', 403), 'clone')
  assert.match(clone, /Cloning is not available in this environment/)
  assert.match(clone, /Create Rate Plan/)
  assert.doesNotMatch(clone, /do not have permission/)
  assert.match(clone, /request req-1/)
  for (const action of ['activate', 'suspend'] as const) {
    const text = describeRatePlanActionError(err('RUNTIME_ROLE_OPERATION_PROHIBITED', 403), action)
    assert.match(text, /lifecycle database role has not been provisioned/)
    assert.doesNotMatch(text, /do not have permission/)
  }
})

test('a genuine permission denial still says so', () => {
  assert.match(describeRatePlanActionError(err('FORBIDDEN', 403), 'activate'), /do not have permission to activate this rate plan/)
})

test('lifecycle conflicts and an unavailable role are actionable and typed', () => {
  assert.match(describeRatePlanActionError(err('RATE_PLAN_CHANGED', 409), 'activate'), /changed since you opened it/)
  assert.match(describeRatePlanActionError(err('RATE_PLAN_NOT_READY', 409), 'activate'), /checklist above/)
  assert.match(describeRatePlanActionError(err('RATE_PLAN_OPS_UNAVAILABLE', 503), 'suspend'), /configured but unavailable/)
})

test('other 4xx keep the server message, with the request id; non-API errors fall back safely', () => {
  assert.equal(describeRatePlanActionError(err('RATE_PLAN_CODE_EXISTS', 409, 'That rate plan code already exists on this contract.'), 'clone'), 'That rate plan code already exists on this contract. (request req-1)')
  assert.equal(describeRatePlanActionError(new Error('boom'), 'clone'), 'Could not clone this rate plan.')
  assert.equal(describeRatePlanActionError(err('X', 500), 'suspend'), 'The Admin API failed to suspend this rate plan. Nothing was saved. (request req-1)')
})
