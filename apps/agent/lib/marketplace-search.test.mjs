import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { destinationSuggestions } from './destination-suggestions.ts'
import { GUEST_MARKETS, clearGuestNationality, guestNationalityKey, isGuestMarket, readGuestNationality, rememberGuestNationality } from './guest-market.ts'
import { occupancyCompact, occupancySummary, resolvedChildAges } from './occupancy.ts'
import { criteriaFilters, minorToWholeAmount, parseWholeAmountMinor } from './search-filters.ts'
import { activeFilterLabel } from './search-summary.ts'
import { appendHotelPage } from './search-page.ts'
import { addUtcDays, applyStayPick, businessToday, defaultSearchStay, monthGrid, nightCount, utcToday } from './stay-calendar.ts'

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
  assert.equal(activeFilterLabel({ maxPriceMinor: 70000 }), 'Up to AED 700 total')
  assert.equal(activeFilterLabel({ minPriceMinor: 40000, maxPriceMinor: 90000, starRatings: [5], refundableOnly: true }), '5★ · Refundable · AED 400–900 total')
  assert.equal(activeFilterLabel({}), '')
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
  assert.equal(resolvedChildAges(1, [null]), null)
  assert.deepEqual(resolvedChildAges(1, [0]), [0])
  assert.equal(resolvedChildAges(2, [8]), null)
})

test('Dubai business date stays on or ahead of the UTC date the server accepts', () => {
  const rollover = Date.parse('2026-10-01T20:30:00.000Z')
  assert.equal(utcToday(rollover), '2026-10-01')
  assert.equal(businessToday(rollover), '2026-10-02')
  assert.equal(businessToday(rollover) >= utcToday(rollover), true)
  assert.deepEqual(defaultSearchStay(rollover, 3), { checkIn: '2026-10-02', checkOut: '2026-10-05' })
  const beforeRollover = Date.parse('2026-10-01T19:30:00.000Z')
  assert.equal(businessToday(beforeRollover), '2026-10-01')
  assert.equal(utcToday(beforeRollover), '2026-10-01')
  assert.equal(defaultSearchStay(beforeRollover, 1).checkOut, '2026-10-02')
})

test('a later page does not repeat hotels already shown', () => {
  const first = [{ hotelId: 'h1' }, { hotelId: 'h2' }]
  const page = appendHotelPage(first, [{ hotelId: 'h2' }, { hotelId: 'h3' }, { hotelId: 'h3' }])
  assert.deepEqual(page.hotels.map((hotel) => hotel.hotelId), ['h1', 'h2', 'h3'])
  assert.deepEqual(page.added.map((hotel) => hotel.hotelId), ['h3'])
  assert.deepEqual(first.map((hotel) => hotel.hotelId), ['h1', 'h2'])
})
