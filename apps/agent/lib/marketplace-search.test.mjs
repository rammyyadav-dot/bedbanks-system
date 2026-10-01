import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { destinationSuggestions } from './destination-suggestions.ts'
import { GUEST_MARKETS, clearGuestNationality, guestNationalityKey, isGuestMarket, readGuestNationality, rememberGuestNationality } from './guest-market.ts'
import { occupancyCompact, occupancySummary } from './occupancy.ts'
import { criteriaFilters, minorToWholeAmount, parseWholeAmountMinor } from './search-filters.ts'
import { addUtcDays, applyStayPick, monthGrid, nightCount } from './stay-calendar.ts'

test('offers Dubai as the only city and never invents hotels, areas, or airports', () => {
  assert.deepEqual(destinationSuggestions('').map((item) => item.value), ['Dubai'])
  assert.equal(destinationSuggestions('dub').every((item) => item.kind !== 'destination-text' || item.value === 'dub'), true)
  const london = destinationSuggestions('London')
  assert.equal(london.some((item) => item.kind === 'city'), false)
  assert.equal(london[0].kind, 'destination-text')
  assert.match(london[0].detail, /destination field only/)
  const text = JSON.stringify(destinationSuggestions('marina'))
  assert.doesNotMatch(text, /airport|landmark|Atlantis|Marriott/i)
})

test('keeps guest markets aligned with search criteria and stores them per account', () => {
  const source = readFileSync(new URL('../../../packages/domain/src/search-offers.cjs', import.meta.url), 'utf8')
  const match = source.match(/SUPPORTED_COUNTRIES = new Set\(\[([^\]]+)\]\)/)
  assert.ok(match)
  const domainCodes = [...match[1].matchAll(/'([A-Z]{2})'/g)].map((item) => item[1]).sort()
  assert.deepEqual(GUEST_MARKETS.map((market) => market.code).sort(), domainCodes)
  assert.equal(isGuestMarket('IN'), true)
  assert.equal(isGuestMarket('ZZ'), false)
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
  rememberGuestNationality(storage, 'agent-a', 'AE')
  rememberGuestNationality(storage, 'agent-a', 'ZZ')
  assert.equal(readGuestNationality(storage, 'agent-a'), 'AE')
  clearGuestNationality(storage, 'agent-a')
  assert.equal(storage.getItem(guestNationalityKey('agent-a')), null)
})

test('converts whole AED amounts to minor units and rejects decimals', () => {
  assert.deepEqual(parseWholeAmountMinor(''), { state: 'empty' })
  assert.deepEqual(parseWholeAmountMinor('700'), { state: 'minor', minor: 70000 })
  assert.deepEqual(parseWholeAmountMinor('700.50'), { state: 'invalid' })
  assert.equal(minorToWholeAmount(70000), '700')
  assert.deepEqual(criteriaFilters({ starRatings: [5, 5, 4], refundableOnly: true, minPriceAed: '150', maxPriceAed: '1500' }), {
    ok: true,
    filters: { starRatings: [4, 5], refundableOnly: true, minPriceMinor: 15000, maxPriceMinor: 150000 },
  })
  assert.equal(criteriaFilters({ starRatings: [], refundableOnly: false, minPriceAed: '', maxPriceAed: '' }).filters, undefined)
  assert.equal(criteriaFilters({ starRatings: [], refundableOnly: false, minPriceAed: '10', maxPriceAed: '2' }).ok, false)
})

test('builds a Monday calendar and refuses a checkout before check-in', () => {
  const grid = monthGrid(2026, 9)
  assert.equal(grid[0].iso, '2026-09-28')
  assert.equal(grid.find((cell) => cell.iso === '2026-10-01')?.inMonth, true)
  assert.equal(nightCount('2026-10-12', '2026-10-15'), 3)
  assert.equal(addUtcDays('2026-10-12', 3), '2026-10-15')
  assert.equal(applyStayPick({ checkIn: '2026-10-12', checkOut: '2026-10-15' }, '2026-10-10', 'check-out', Date.parse('2026-10-01T00:00:00Z')), null)
  assert.deepEqual(applyStayPick({ checkIn: '2026-10-12', checkOut: '2026-10-15' }, '2026-10-20', 'check-out', Date.parse('2026-10-01T00:00:00Z')), {
    checkIn: '2026-10-12', checkOut: '2026-10-20', selecting: 'check-in',
  })
  assert.equal(occupancySummary(1, 2, 0), '1 Room · 2 Adults · 0 Children')
  assert.equal(occupancyCompact(3, 6, 2), '3R · 6A · 2C')
})
