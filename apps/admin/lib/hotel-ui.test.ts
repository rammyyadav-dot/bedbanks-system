import test from 'node:test'
import assert from 'node:assert/strict'
import { COMMERCIAL_ISSUE_CATEGORIES, COMMERCIAL_REASON_TEXT, HOTEL_STAR_RATING_MISSING } from '@bedbanks/contracts'
import { HOTEL_TABS, contractTone, hotelHref, inventoryTone, listHref, mappingTone, parseTab, readListQuery, readinessTone, reasonText, sectionTab, severityTone, starsText } from './hotel-ui'

test('readiness, mapping, contract and inventory states map to tones without inventing states', () => {
  assert.deepEqual(['READY', 'PARTIAL', 'BLOCKED'].map((s) => readinessTone(s as never)), ['ok', 'warn', 'bad'])
  assert.deepEqual(['MAPPED', 'PENDING', 'REJECTED', 'NONE'].map((s) => mappingTone(s as never)), ['ok', 'warn', 'bad', 'bad'])
  assert.deepEqual(['ACTIVE', 'EXPIRING', 'INACTIVE', 'EXPIRED', 'NONE'].map((s) => contractTone(s as never)), ['ok', 'warn', 'warn', 'bad', 'bad'])
  assert.deepEqual(['OK', 'STOP_SELL', 'GAPS', 'EXHAUSTED', 'NONE'].map((s) => inventoryTone(s as never)), ['ok', 'warn', 'bad', 'bad', 'neutral'])
  assert.deepEqual(['CRITICAL', 'HIGH', 'WARNING'].map((s) => severityTone(s as never)), ['bad', 'warn', 'neutral'])
})

test('every canonical reason code the Admin can receive has plain wording, and unknown codes are shown verbatim, never hidden', () => {
  for (const code of ['SUPPLIER_MAPPING_INVALID', 'OUTSIDE_CONTRACT_VALIDITY', 'DAILY_RATE_MISSING_OR_INVALID', 'AVAILABILITY_MISSING', 'STOP_SELL', 'NO_INVENTORY', 'OCCUPANCY_UNSUPPORTED', 'RATE_CURRENCY_MISMATCH', HOTEL_STAR_RATING_MISSING, 'MIN_STAY_NOT_MET']) {
    assert.ok(COMMERCIAL_REASON_TEXT[code], code)
    assert.equal(reasonText(code), COMMERCIAL_REASON_TEXT[code])
  }
  assert.equal(reasonText('SOME_FUTURE_CODE'), 'SOME_FUTURE_CODE')
})

test('tabs: every issue section is a real tab, unknown tab values fall back to overview, and links are stable', () => {
  const ids = HOTEL_TABS.map((t) => t.id) as string[]
  for (const section of ['overview', 'rooms', 'mappings', 'contracts', 'rates', 'sellability'] as const) assert.ok(ids.includes(sectionTab(section)), section)
  assert.equal(parseTab('rates'), 'rates'); assert.equal(parseTab('nonsense'), 'overview'); assert.equal(parseTab(null), 'overview'); assert.equal(parseTab('__proto__'), 'overview')
  assert.equal(hotelHref('h1'), '/hotels/h1'); assert.equal(hotelHref('h1', 'rates'), '/hotels/h1?tab=rates'); assert.equal(hotelHref('a b/c', 'rooms'), '/hotels/a b/c?tab=rooms')
  assert.equal(COMMERCIAL_ISSUE_CATEGORIES.length, 13)
})

test('list filters round-trip through the URL and unknown parameters are dropped', () => {
  const parsed = readListQuery(new URLSearchParams('search=palm&readiness=BLOCKED&page=3&evil=1&tenantId=x'))
  assert.deepEqual(parsed, { filters: { search: 'palm', readiness: 'BLOCKED' }, page: 3 })
  assert.equal(listHref(parsed.filters, parsed.page), '/hotels?search=palm&readiness=BLOCKED&page=3')
  assert.equal(listHref({}), '/hotels'); assert.equal(listHref({ mapping: 'NONE' }, 1), '/hotels?mapping=NONE')
  assert.equal(readListQuery(new URLSearchParams('page=0')).page, 1); assert.equal(readListQuery(new URLSearchParams('page=abc')).page, 1); assert.equal(readListQuery(new URLSearchParams('page=2.5')).page, 1)
})

test('stars text is explicit for assistive technology and for a missing rating', () => {
  assert.equal(starsText(5), '5 stars'); assert.equal(starsText(1), '1 star'); assert.equal(starsText(null), 'No rating')
})
