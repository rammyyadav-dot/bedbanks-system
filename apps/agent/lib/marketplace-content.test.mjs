import assert from 'node:assert/strict'
import test from 'node:test'
import { brandTagline, contactEmail, dubaiSpotlight, editorialDestinations, editorialPages, heroCopy, homeCopy, marketplaceHome, tradeAnnouncements } from './marketplace-content.ts'

const text = JSON.stringify({ brandTagline, homeCopy, heroCopy, editorialPages, editorialDestinations, tradeAnnouncements, dubaiSpotlight, marketplaceHome })

test('keeps the approved entrance copy and verified contact email', () => {
  assert.equal(heroCopy.headline, 'Book wholesale hotels with total clarity.')
  assert.equal(brandTagline, 'Wholesale hotels. Trade-ready.')
  assert.match(heroCopy.supporting, /recheck availability/)
  assert.equal(contactEmail, 'hello@fbeds.com')
  assert.equal(dubaiSpotlight.destination, 'Dubai')
  assert.equal(marketplaceHome.title, 'Search hotel inventory')
  assert.equal(marketplaceHome.supporting, 'Find available hotel rates, compare room and board options, and recheck the selected offer before proceeding.')
  assert.equal(marketplaceHome.resultsQuote, 'Search quotes — price and availability require recheck before proceeding.')
  assert.doesNotMatch(marketplaceHome.title, /global/i)
  assert.doesNotMatch(marketplaceHome.supporting, /verified availability/i)
  assert.equal(marketplaceHome.currencyCode, 'AED')
  assert.equal(marketplaceHome.searchCta, 'Search')
  assert.equal(marketplaceHome.destinationPlaceholder, 'City or destination')
  assert.match(marketplaceHome.advancedNote, /stay total/)
  assert.equal(editorialPages.access.summary.includes('does not create an account'), true)
})

test('does not publish invented commercial claims', () => {
  assert.doesNotMatch(text, /\d[\d,]*\+?\s*(hotels|suppliers|properties|countries|agents)/i)
  assert.doesNotMatch(text, /discount|%\s*off|exclusive|save\s+\d|limited availability|only \d+ left/i)
  assert.doesNotMatch(text, /\+\d{6,}|street|response within/i)
})

test('labels future destinations as editorial and not searchable', () => {
  for (const destination of editorialDestinations) {
    assert.match(destination.note, /Not a searchable destination/)
  }
})
