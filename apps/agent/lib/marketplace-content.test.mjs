import assert from 'node:assert/strict'
import test from 'node:test'
import { contactEmail, dubaiSpotlight, editorialDestinations, editorialPages, heroCopy, tradeAnnouncements } from './marketplace-content.ts'

const text = JSON.stringify({ heroCopy, editorialPages, editorialDestinations, tradeAnnouncements, dubaiSpotlight })

test('keeps the approved entrance copy and verified contact email', () => {
  assert.equal(heroCopy.headline, 'Your gateway to smarter hotel distribution.')
  assert.match(heroCopy.supporting, /recheck availability/)
  assert.equal(contactEmail, 'hello@fbeds.com')
  assert.equal(dubaiSpotlight.destination, 'Dubai')
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
