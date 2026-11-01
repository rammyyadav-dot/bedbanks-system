import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { beginSearchRun, idleSearchRun, invalidateSearchRun, settleSearchRun } from './search-attempt.ts'

function start() {
  const started = beginSearchRun(idleSearchRun())
  assert.ok(started)
  return started
}

test('editing the destination during a search clears Searching and allows another submit', () => {
  const inFlight = start()
  const edited = invalidateSearchRun(inFlight)
  assert.equal(edited.searching, false)
  assert.notEqual(edited.generation, inFlight.generation)
  const again = beginSearchRun(edited)
  assert.ok(again)
  assert.equal(again.searching, true)
  const settled = settleSearchRun(again, again.generation)
  assert.equal(settled.apply, true)
  assert.equal(settled.state.searching, false)
})

test('editing dates during a search clears Searching and allows another submit', () => {
  const inFlight = start()
  const edited = invalidateSearchRun(inFlight)
  const again = beginSearchRun(edited)
  assert.ok(again)
  assert.equal(settleSearchRun(again, again.generation).state.searching, false)
})

test('an old resolve after reset does not apply and does not latch Searching', () => {
  const inFlight = start()
  const edited = invalidateSearchRun(inFlight)
  const stale = settleSearchRun(edited, inFlight.generation)
  assert.equal(stale.apply, false)
  assert.equal(stale.state.searching, false)
  assert.equal(stale.state.generation, edited.generation)
})

test('an old rejection after reset does not apply and does not latch Searching', () => {
  const inFlight = start()
  const edited = invalidateSearchRun(inFlight)
  const stale = settleSearchRun(edited, inFlight.generation)
  assert.equal(stale.apply, false)
  assert.equal(stale.state.searching, false)
})

test('a newer search that finishes first stays authoritative when the older search settles', () => {
  const older = start()
  const edited = invalidateSearchRun(older)
  const newer = beginSearchRun(edited)
  assert.ok(newer)
  const newerDone = settleSearchRun(newer, newer.generation)
  assert.equal(newerDone.apply, true)
  assert.equal(newerDone.state.searching, false)
  const olderDone = settleSearchRun(newerDone.state, older.generation)
  assert.equal(olderDone.apply, false)
  assert.equal(olderDone.state.searching, false)
  assert.equal(olderDone.state.generation, newer.generation)
})

test('the authoritative completion is the only path that clears Searching', () => {
  const first = start()
  assert.equal(beginSearchRun(first), null)
  const done = settleSearchRun(first, first.generation)
  assert.equal(done.apply, true)
  assert.equal(done.state.searching, false)
  const second = beginSearchRun(done.state)
  assert.ok(second)
  assert.equal(settleSearchRun(second, second.generation).state.searching, false)
})

test('the portal uses the search-run helpers instead of latching searching', () => {
  const source = readFileSync(new URL('../components/agent-portal.tsx', import.meta.url), 'utf8')
  assert.match(source, /invalidateSearchRun/)
  assert.match(source, /beginSearchRun/)
  assert.match(source, /settleSearchRun/)
  assert.match(source, /searchingRef/)
  assert.doesNotMatch(source, /if \(searching\) return/)
})
