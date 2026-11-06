import assert from 'node:assert/strict'
import test from 'node:test'
import { searchOutcome } from './search-outcome.ts'
import { replaceSearchResult } from './search-refresh.ts'

test('permission denial, suspension, and an expired session replace any hotels already on screen', () => {
  for (const status of ['access_denied', 'agency_suspended', 'auth_required', 'destination_unavailable']) {
    assert.equal(replaceSearchResult(true, status), true, status)
    const outcome = searchOutcome(status)
    if (status !== 'agency_suspended') {
      assert.match(outcome.body, /No hotels are shown/)
      assert.equal(outcome.retry, false)
    }
  }
})

test('a timed-out search keeps the previous list and tells the agent to search again before using a price', () => {
  assert.equal(replaceSearchResult(true, 'provider_unavailable'), false)
  assert.equal(replaceSearchResult(false, 'provider_unavailable'), true)
  const outcome = searchOutcome('provider_unavailable')
  assert.equal(outcome.retry, true)
  assert.match(outcome.body, /Nothing was booked/)
  assert.match(outcome.body, /Run the search again/)
})

test('a completed search still replaces the list', () => {
  for (const status of ['available', 'partial', 'empty', 'mapping_unavailable']) {
    assert.equal(replaceSearchResult(true, status), true)
  }
})
