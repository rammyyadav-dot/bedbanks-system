import assert from 'node:assert/strict'
import test from 'node:test'
import { clearRecentSearches, consumeExpiredSession, deleteRecentSearch, markAgentSession, readRecentSearches, recentSearchIdentity, recentSearchKey, rememberRecentSearch } from './recent-searches.ts'

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

test('keeps criteria only, separates nationality, and deletes one search', () => {
  const storage = memory()
  rememberRecentSearch(storage, 'agent-a', { ...search, nationality: 'IN', quotedTotal: 31500 })
  rememberRecentSearch(storage, 'agent-a', { ...search, nationality: 'AE' })
  const saved = readRecentSearches(storage, 'agent-a')
  assert.equal(saved.length, 2)
  assert.equal(saved[0].nationality, 'AE')
  assert.equal('quotedTotal' in saved[0], false)
  assert.doesNotMatch(storage.getItem(recentSearchKey('agent-a')), /31500/)
  deleteRecentSearch(storage, 'agent-a', saved[0])
  assert.equal(readRecentSearches(storage, 'agent-a').length, 1)
  assert.equal(readRecentSearches(storage, 'agent-a')[0].nationality, 'IN')
})

test('stores filters and keeps the newest eight searches', () => {
  const storage = memory()
  for (let index = 0; index < 9; index += 1) {
    rememberRecentSearch(storage, 'agent-a', { ...search, destination: `City ${index}`, nationality: 'IN', starRatings: [5], refundableOnly: true, minPriceMinor: 10000, maxPriceMinor: 70000 })
  }
  const saved = readRecentSearches(storage, 'agent-a')
  assert.equal(saved.length, 8)
  assert.equal(saved[0].destination, 'City 8')
  assert.deepEqual(saved[0].starRatings, [5])
  assert.equal(saved[0].minPriceMinor, 10000)
  assert.equal(saved.some((item) => item.destination === 'City 0'), false)
})

test('keeps searches that differ only by refundable or total-stay price', () => {
  const storage = memory()
  const priced = { ...search, nationality: 'IN', childAges: [], refundableOnly: true, minPriceMinor: 40000, maxPriceMinor: 90000 }
  const open = { ...search, nationality: 'IN', childAges: [], minPriceMinor: 40000, maxPriceMinor: 90000 }
  rememberRecentSearch(storage, 'agent-a', priced)
  rememberRecentSearch(storage, 'agent-a', open)
  const saved = readRecentSearches(storage, 'agent-a')
  assert.equal(saved.length, 2)
  assert.notEqual(recentSearchIdentity(saved[0]), recentSearchIdentity(saved[1]))
  assert.equal(saved.some((item) => item.refundableOnly === true), true)
})

test('marks a session without treating logout as expiry', () => {
  const storage = memory()
  assert.equal(consumeExpiredSession(storage), false)
  markAgentSession(storage)
  assert.equal(consumeExpiredSession(storage), true)
  assert.equal(consumeExpiredSession(storage), false)
})
