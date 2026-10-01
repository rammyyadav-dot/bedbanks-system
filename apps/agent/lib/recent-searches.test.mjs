import assert from 'node:assert/strict'
import test from 'node:test'
import { clearRecentSearches, consumeExpiredSession, markAgentSession, readRecentSearches, recentSearchKey, rememberRecentSearch } from './recent-searches.ts'

function memory() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

const search = { destination: 'Dubai', checkIn: '2026-10-02', checkOut: '2026-10-05', rooms: 1, adults: 2, children: 0, childAges: [] }

test('stores recent searches per account and drops credentials', () => {
  const storage = memory()
  rememberRecentSearch(storage, 'agent-a', { ...search, password: 'secret', offerId: 'offer-1' })
  rememberRecentSearch(storage, 'agent-a', search)
  rememberRecentSearch(storage, 'agent-b', { ...search, destination: 'Other' })
  const saved = readRecentSearches(storage, 'agent-a')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].destination, 'Dubai')
  assert.equal('password' in saved[0], false)
  assert.equal(readRecentSearches(storage, 'agent-b')[0].destination, 'Other')
  assert.doesNotMatch(storage.getItem(recentSearchKey('agent-a')), /secret|offer-1/)
})

test('clears only the signed-out account', () => {
  const storage = memory()
  rememberRecentSearch(storage, 'agent-a', search)
  rememberRecentSearch(storage, 'agent-b', search)
  clearRecentSearches(storage, 'agent-a')
  assert.deepEqual(readRecentSearches(storage, 'agent-a'), [])
  assert.equal(readRecentSearches(storage, 'agent-b').length, 1)
})

test('marks a session without treating logout as expiry', () => {
  const storage = memory()
  assert.equal(consumeExpiredSession(storage), false)
  markAgentSession(storage)
  assert.equal(consumeExpiredSession(storage), true)
  assert.equal(consumeExpiredSession(storage), false)
})
