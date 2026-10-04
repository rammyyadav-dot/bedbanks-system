import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMERCIAL_CONTROL_UNAVAILABLE, DATABASE_ROLE_NOT_PERMITTED, OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { ApiResponseError } from './api/errors'
import { classifyOpsFailure, failureReference, opsQuery, OPS_FAILURE_COPY } from './ops-state'

test('each failure class is distinct and none is "empty"', () => {
  assert.equal(classifyOpsFailure(new ApiResponseError('UNAUTHORIZED', 'x', 401)), 'unauthenticated')
  assert.equal(classifyOpsFailure(new ApiResponseError('FORBIDDEN', 'x', 403)), 'forbidden')
  assert.equal(classifyOpsFailure(new ApiResponseError(OPERATIONS_READ_DENIED, 'x', 503)), 'denied')
  assert.equal(classifyOpsFailure(new ApiResponseError('NOT_FOUND', 'x', 404)), 'not-found')
  assert.equal(classifyOpsFailure(new ApiResponseError(DATABASE_ROLE_NOT_PERMITTED, 'x', 503)), 'not-configured')
  assert.equal(classifyOpsFailure(new ApiResponseError(COMMERCIAL_CONTROL_UNAVAILABLE, 'x', 503)), 'not-configured')
  assert.equal(classifyOpsFailure(new ApiResponseError('NETWORK_ERROR', 'x', 0)), 'unreachable')
  assert.equal(classifyOpsFailure(new ApiResponseError('API_TIMEOUT', 'x', 504)), 'unreachable')
  assert.equal(classifyOpsFailure(new ApiResponseError('INTERNAL_SERVER_ERROR', 'x', 500)), 'error')
  assert.equal(classifyOpsFailure(new Error('boom')), 'error')
  const titles = Object.values(OPS_FAILURE_COPY).map((c) => c.title)
  assert.equal(new Set(titles).size, titles.length)
})

test('a plain 503 is an error, only the explicit code is a privilege boundary', () => {
  assert.equal(classifyOpsFailure(new ApiResponseError('SERVICE_UNAVAILABLE', 'x', 503)), 'error')
})

test('failure reference carries code, status and request id but never the message body', () => {
  assert.equal(failureReference(new ApiResponseError('FORBIDDEN', 'secret detail', 403, 'req-1')), 'FORBIDDEN (HTTP 403) · request req-1')
  assert.equal(failureReference(new Error('x')), null)
})

test('query strings drop empty values and encode the rest', () => {
  assert.equal(opsQuery({ page: 1, status: '', reference: undefined, q: 'a b&c' }), '?page=1&q=a+b%26c')
  assert.equal(opsQuery({}), '')
})
