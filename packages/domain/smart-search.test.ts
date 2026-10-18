import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDestinationAlias, businessDate, parseSmartSearch } from './src/smart-search.ts'

const TODAY = '2026-10-16' // a Friday

test('the brief example: 5-star Dubai near Marina, 2 adults, 3 nights from next Friday', () => {
  const r = parseSmartSearch('5-star hotel in Dubai near Marina for 2 adults 3 nights from next Friday', TODAY)
  assert.equal(r.destinationText, 'Dubai')
  assert.equal(r.nearText, 'Marina')
  assert.deepEqual(r.starRatings, [5])
  assert.deepEqual(r.rooms, [{ adults: 2, childAges: [] }])
  assert.equal(r.checkIn, '2026-10-23')
  assert.equal(r.checkOut, '2026-10-26')
  assert.equal(r.nights, 3)
  assert.deepEqual(r.unresolved, ['nationality'])
  assert.match(r.notes.join(' '), /near Marina.*not applied/)
})

test('a pasted client email with explicit dates, children with ages and nationality', () => {
  const email = `Hi team,
Please quote 2 rooms in Abu Dhabi, 23rd Oct to 27 Oct, 4 adults and 2 children aged 5 and 9.
Guests are Indian passport holders. 4 star or above please. Thanks, Priya`
  const r = parseSmartSearch(email, TODAY)
  assert.equal(r.destinationText, 'Abu Dhabi')
  assert.equal(r.checkIn, '2026-10-23')
  assert.equal(r.checkOut, '2026-10-27')
  assert.deepEqual(r.rooms, [{ adults: 2, childAges: [5] }, { adults: 2, childAges: [9] }])
  assert.equal(r.nationality, 'IN')
  assert.deepEqual(r.starRatings, [4, 5])
  assert.deepEqual(r.unresolved, [])
})

test('dates: ISO, day-first numeric, month-first, relative words, and the next occurrence of a day without a year', () => {
  assert.equal(parseSmartSearch('Dubai 2026-11-02 to 2026-11-05 2 adults', TODAY).checkOut, '2026-11-05')
  assert.equal(parseSmartSearch('in Dubai 2/11 - 5/11 for 2 adults', TODAY).checkIn, '2026-11-02')
  assert.equal(parseSmartSearch('in Dubai Nov 2 for 2 nights', TODAY).checkOut, '2026-11-04')
  assert.equal(parseSmartSearch('in Dubai tomorrow for 1 night', TODAY).checkIn, '2026-10-17')
  assert.equal(parseSmartSearch('in Dubai in 10 days, two nights', TODAY).checkIn, '2026-10-26')
  assert.equal(parseSmartSearch('in Dubai this Sunday for 2 nights', TODAY).checkIn, '2026-10-18')
  assert.equal(parseSmartSearch('in Dubai on 3 Jan for 2 nights', TODAY).checkIn, '2027-01-03')
})

test('refuses rather than guesses: past dates, too long, missing check-out, unsupported occupancy, missing child ages', () => {
  const past = parseSmartSearch('in Dubai 2026-10-01 to 2026-10-03', TODAY)
  assert.equal(past.checkIn, undefined)
  assert.ok(past.unresolved.includes('dates'))
  assert.equal(parseSmartSearch('in Dubai 2026-11-01 to 2026-12-15', TODAY).checkIn, undefined)
  const open = parseSmartSearch('in Dubai from 2 Nov', TODAY)
  assert.equal(open.checkIn, undefined)
  assert.match(open.notes.join(' '), /no check-out/)
  const crowd = parseSmartSearch('in Dubai 9 adults 1 room', TODAY)
  assert.equal(crowd.rooms, undefined)
  assert.match(crowd.notes.join(' '), /not a supported occupancy/)
  const kids = parseSmartSearch('in Dubai 2 adults 2 children', TODAY)
  assert.equal(kids.rooms, undefined)
  assert.match(kids.notes.join(' '), /child needs an age/)
})

test('nationality: a demonym or an explicit cue, never the destination country', () => {
  assert.equal(parseSmartSearch('hotel in the UAE for 2 adults', TODAY).nationality, undefined)
  assert.equal(parseSmartSearch('British couple, Dubai, 3 nights', TODAY).nationality, 'GB')
  assert.equal(parseSmartSearch('in Dubai, nationality: Saudi Arabia', TODAY).nationality, 'SA')
  assert.equal(parseSmartSearch('in Dubai, passport holders of Kenya', TODAY).nationality, undefined)
})

test('aliases rewrite multi-language and old names to the catalogue spelling; unknown text is unchanged', () => {
  assert.equal(applyDestinationAlias('دبي'), 'Dubai')
  assert.equal(applyDestinationAlias('Dubaï'), 'Dubai')
  assert.equal(applyDestinationAlias('bombay'), 'Mumbai')
  assert.equal(applyDestinationAlias('Atlantis The Palm'), 'Atlantis The Palm')
  assert.equal(parseSmartSearch('فندق في دبي 2 adults', TODAY).destinationText, 'Dubai')
  assert.equal(parseSmartSearch('a couple to Bombay next week for 2 nights', TODAY).destinationText, 'Mumbai')
})

test('empty input resolves nothing, and the business date follows Asia/Dubai', () => {
  assert.deepEqual(parseSmartSearch('   ', TODAY).unresolved, ['destination', 'dates', 'occupancy', 'stars', 'nationality'])
  assert.equal(businessDate(new Date('2026-10-16T21:30:00.000Z')), '2026-10-17')
  assert.equal(businessDate(new Date('2026-10-16T19:30:00.000Z')), '2026-10-16')
})
