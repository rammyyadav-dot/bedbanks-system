import assert from 'node:assert/strict'
import test from 'node:test'
import { isSearchRequestFailure, replaceSearchResult } from './search-refresh.ts'

test('a failed refresh keeps the previous successful result', () => {
  for (const status of ['provider_unavailable', 'auth_required', 'access_denied', 'destination_unavailable']) {
    assert.equal(isSearchRequestFailure(status), true)
    assert.equal(replaceSearchResult(true, status), false)
  }
})

test('an empty, partial, or available search replaces the list', () => {
  for (const status of ['available', 'partial', 'empty', 'no_availability', 'mapping_unavailable']) {
    assert.equal(replaceSearchResult(true, status), true)
    assert.equal(replaceSearchResult(false, status), true)
  }
})

test('the first search has no previous result to retain', () => {
  assert.equal(replaceSearchResult(false, 'provider_unavailable'), true)
})
