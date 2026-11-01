import assert from 'node:assert/strict'
import test from 'node:test'
import { SEARCH_TEMPORARILY_UNAVAILABLE, searchAttemptNotice } from './search-notice.ts'

test('a resolved provider failure and an unexpected throw share one sanitized notice', () => {
  assert.equal(searchAttemptNotice({ kind: 'resolved', status: 'provider_unavailable' }), SEARCH_TEMPORARILY_UNAVAILABLE)
  assert.equal(searchAttemptNotice({ kind: 'thrown' }), SEARCH_TEMPORARILY_UNAVAILABLE)
  assert.doesNotMatch(SEARCH_TEMPORARILY_UNAVAILABLE, /https?:|password|stack|supplier/i)
})

test('empty, partial, and available searches do not raise a provider-failure notice', () => {
  for (const status of ['empty', 'partial', 'available', 'mapping_unavailable', 'auth_required', 'access_denied']) {
    assert.equal(searchAttemptNotice({ kind: 'resolved', status }), null)
  }
})
