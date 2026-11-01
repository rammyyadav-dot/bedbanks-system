import test from 'node:test'
import assert from 'node:assert/strict'
import { reasonLabel, suggestionPath, suggestionView } from './hotel-mapping-suggestions-ui'

test('a query needs a name of at least two characters', () => {
  assert.equal(suggestionPath({ name: '' }), null)
  assert.equal(suggestionPath({ name: ' a ' }), null)
  assert.equal(suggestionPath({ name: 'Hilton' }), '/supply/mappings/hotels/suggestions?name=Hilton')
})

test('blank optional fields are dropped, the country is upper-cased and values are encoded', () => {
  assert.equal(
    suggestionPath({ name: 'Double Tree & Spa', address: ' ', city: 'Dubai', countryCode: 'ae' }),
    '/supply/mappings/hotels/suggestions?name=Double+Tree+%26+Spa&city=Dubai&countryCode=AE',
  )
})

test('an unpopulated index is never presented as "no match"', () => {
  assert.deepEqual(suggestionView({ indexReady: false, suggestions: [] }), { kind: 'index-empty' })
  assert.deepEqual(suggestionView({ indexReady: true, suggestions: [] }), { kind: 'none' })
  const hit = { hotelId: 'h1', name: 'A', city: 'B', countryCode: 'AE', confidence: 90, tier: 'HIGH_CONFIDENCE' as const, reasons: [] }
  assert.deepEqual(suggestionView({ indexReady: true, suggestions: [hit] }), { kind: 'matches', suggestions: [hit] })
})

test('known reasons read as plain language and unknown ones degrade gracefully', () => {
  assert.equal(reasonLabel('geo_proximity'), 'Within 500 m')
  assert.equal(reasonLabel('some_new_reason'), 'some new reason')
})
