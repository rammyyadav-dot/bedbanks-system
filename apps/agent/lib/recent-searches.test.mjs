import assert from 'node:assert/strict'
import test from 'node:test'
import { canReplayRecentSearch, clearRecentSearches, consumeExpiredSession, deleteRecentSearch, markAgentSession, readRecentSearches, recentSearchIdentity, recentSearchKey, rememberRecentSearch } from './recent-searches.ts'

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

test('does not replay a saved search that has no canonical destination', () => {
  const storage = memory()
  rememberRecentSearch(storage, 'agent-a', search)
  const saved = readRecentSearches(storage, 'agent-a')
  assert.equal(canReplayRecentSearch(saved[0]), false)
  const canonical = {
    ...search,
    currency: 'AED',
    destinationRef: { type: 'city', id: 'city:AE:dubai', countryCode: 'AE' },
    roomStays: [{ adults: 2, children: [] }],
  }
  rememberRecentSearch(storage, 'agent-a', canonical)
  const next = readRecentSearches(storage, 'agent-a')
  assert.equal(canReplayRecentSearch(next[0]), true)
  assert.equal(next[0].destinationRef.id, 'city:AE:dubai')
  assert.deepEqual(next[0].roomStays, [{ adults: 2, children: [] }])
})

test('marks a session without treating logout as expiry', () => {
  const storage = memory()
  assert.equal(consumeExpiredSession(storage), false)
  markAgentSession(storage)
  assert.equal(consumeExpiredSession(storage), true)
  assert.equal(consumeExpiredSession(storage), false)
})

test('tenant histories are isolated and tenant change clears only the departed tenant', () => {
  const storage = memory()
  rememberRecentSearch(storage, 'agent-a', search, 'tenant-a')
  rememberRecentSearch(storage, 'agent-a', { ...search, destination: 'Other' }, 'tenant-b')
  assert.equal(readRecentSearches(storage, 'agent-a', 'tenant-a')[0].destination, 'Dubai')
  assert.equal(readRecentSearches(storage, 'agent-a', 'tenant-b')[0].destination, 'Other')
  assert.deepEqual(readRecentSearches(storage, 'agent-a'), [])
  clearRecentSearches(storage, 'agent-a', 'tenant-a')
  assert.deepEqual(readRecentSearches(storage, 'agent-a', 'tenant-a'), [])
  assert.equal(readRecentSearches(storage, 'agent-a', 'tenant-b').length, 1)
})

test('logout clears every tenant history for the account, preserving another account', () => {
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), key: (index) => [...values.keys()][index], get length() { return values.size } }
  rememberRecentSearch(storage, 'a', search, 'tenant-1')
  rememberRecentSearch(storage, 'a', search, 'tenant-2')
  rememberRecentSearch(storage, 'b', search, 'tenant-1')
  clearRecentSearches(storage, 'a')
  assert.deepEqual(readRecentSearches(storage, 'a', 'tenant-1'), [])
  assert.deepEqual(readRecentSearches(storage, 'a', 'tenant-2'), [])
  assert.equal(readRecentSearches(storage, 'b', 'tenant-1').length, 1)
})

test('deduplication includes board and property filters and ignores their order', () => {
  const storage = memory()
  rememberRecentSearch(storage, 'a', { ...search, boardBasisIds: ['BB', 'RO'], propertyTypes: ['HOTEL'] }, 't')
  rememberRecentSearch(storage, 'a', { ...search, boardBasisIds: ['RO', 'BB'], propertyTypes: ['HOTEL'] }, 't')
  rememberRecentSearch(storage, 'a', { ...search, boardBasisIds: ['BB'], propertyTypes: ['HOTEL'] }, 't')
  assert.equal(readRecentSearches(storage, 'a', 't').length, 2)
})
