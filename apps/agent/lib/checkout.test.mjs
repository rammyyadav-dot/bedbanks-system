import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRoster, isLead, parseCcEmails, rosterErrors, rosterPayload } from './checkout.ts'

test('roster: every guest of every identical room, children carry their searched age, room 1 first adult is lead', () => {
  const roster = buildRoster(2, 2, [5])
  assert.equal(roster.length, 6)
  assert.deepEqual(roster.map((g) => `${g.roomNumber}${g.type[0]}${g.age ?? ''}`), ['1A', '1A', '1C5', '2A', '2A', '2C5'])
  assert.equal(roster.filter((g) => isLead(g, roster)).length, 1)
  assert.equal(isLead(roster[0], roster), true)
})

test('roster validation and payload: names required, letters only, titles optional, ages only for children', () => {
  const roster = buildRoster(1, 2, [])
  assert.deepEqual(Object.keys(rosterErrors(roster)), ['r1a0', 'r1a1'])
  roster[0] = { ...roster[0], title: 'Mrs', firstName: ' Layla ', lastName: "O'Hara" }
  roster[1] = { ...roster[1], firstName: '<b>', lastName: 'X' }
  assert.deepEqual(rosterErrors(roster), { r1a1: 'Use letters only (up to 80 characters each).' })
  roster[1] = { ...roster[1], firstName: 'Omar' }
  assert.deepEqual(rosterErrors(roster), {})
  assert.deepEqual(rosterPayload(roster), [{ roomNumber: 1, type: 'ADULT', title: 'Mrs', firstName: 'Layla', lastName: "O'Hara" }, { roomNumber: 1, type: 'ADULT', firstName: 'Omar', lastName: 'X' }])
  assert.deepEqual(rosterPayload(buildRoster(1, 1, [9]).map((g) => ({ ...g, firstName: 'A', lastName: 'B' })))[1], { roomNumber: 1, type: 'CHILD', firstName: 'A', lastName: 'B', age: 9 })
})

test('CC emails: comma, semicolon or space separated; de-duplicated; never the agent; at most three', () => {
  assert.deepEqual(parseCcEmails('', 'me@agency.example'), { ok: true, emails: [] })
  assert.deepEqual(parseCcEmails(' Ops@Agency.example; ops@agency.example, me@agency.example ', 'me@agency.example'), { ok: true, emails: ['ops@agency.example'] })
  assert.equal(parseCcEmails('nope', null).ok, false)
  assert.equal(parseCcEmails('a@x.example b@x.example c@x.example d@x.example', null).ok, false)
})
