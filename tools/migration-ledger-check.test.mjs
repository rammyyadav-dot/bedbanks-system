import assert from 'node:assert/strict'
import test from 'node:test'
import { chainDigest, checkChain, checkHistory, parseMigration, readChain } from './migration-ledger-check.mjs'

const m = (name) => ({ ...parseMigration(name, Buffer.from(`-- ${name}\nSELECT 1;\n`)), checksum: `sum-${name}` })
const LOCK = 'provider = "postgresql"\n'
const chainOf = (...names) => ({ migrations: names.map((n) => m(n)), lock: LOCK, strays: [] })
const row = (name, extra = {}) => ({ migration_name: name, checksum: `sum-${name}`, started_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:00:01Z', rolled_back_at: null, applied_steps_count: 1, ...extra })
const opts = { today: '20261020', knownCollisions: new Set() }

test('the committed chain passes', () => {
  const { failures } = checkChain(readChain())
  assert.deepEqual(failures, [])
})

test('chain: a new ID collision fails; a listed one passes', () => {
  const chain = chainOf('202610010001_a', '202610010001_b')
  assert.match(checkChain(chain, opts).failures.join(), /ID collision 202610010001/)
  assert.deepEqual(checkChain(chain, { ...opts, knownCollisions: new Set(['202610010001']) }).failures, [])
})

test('chain: names, dates, times, empty SQL, strays and the lock provider', () => {
  assert.match(checkChain(chainOf('2026100100_short'), opts).failures.join(), /name must be/)
  assert.match(checkChain(chainOf('202602300001_feb30'), opts).failures.join(), /not a valid UTC calendar date/)
  assert.match(checkChain(chainOf('20261001250000_hour25'), opts).failures.join(), /not a valid UTC time/)
  assert.match(checkChain({ ...chainOf('202610010001_a'), migrations: [{ ...m('202610010001_a'), empty: true }] }, opts).failures.join(), /missing or empty/)
  assert.match(checkChain({ ...chainOf('202610010001_a'), strays: ['notes.sql'] }, opts).failures.join(), /unexpected file/)
  assert.match(checkChain({ ...chainOf('202610010001_a'), lock: 'provider = "mysql"' }, opts).failures.join(), /postgresql/)
})

test('chain: future-dated IDs are reported, not failed', () => {
  const { failures, futureDated } = checkChain(chainOf('202610010001_a', '202612010001_b'), opts)
  assert.deepEqual(failures, [])
  assert.deepEqual(futureDated, ['202612010001_b'])
})

test('history before: pending count, unknown, failed, edited and out-of-order migrations', () => {
  const migrations = chainOf('202610010001_a', '202610020001_b', '202610030001_c').migrations
  const ok = checkHistory([row('202610010001_a')], migrations, { phase: 'before', expectPending: 2 })
  assert.deepEqual(ok.failures, [])
  assert.equal(ok.summary.pending, 2)
  assert.equal(ok.summary.firstPending, '202610020001_b')
  assert.match(checkHistory([row('202610010001_a')], migrations, { phase: 'before', expectPending: 91 }).failures.join(), /expected 91 pending/)
  assert.match(checkHistory([row('202609010001_gone')], migrations, { phase: 'before' }).failures.join(), /not in this commit/)
  assert.match(checkHistory([row('202610010001_a', { finished_at: null })], migrations, { phase: 'before' }).failures.join(), /never finished/)
  assert.match(checkHistory([row('202610010001_a', { checksum: 'edited' })], migrations, { phase: 'before' }).failures.join(), /was edited/)
  assert.match(checkHistory([row('202610010001_a'), row('202610030001_c')], migrations, { phase: 'before' }).failures.join(), /202610020001_b: pending but sorts before/)
})

test('history: a rolled-back attempt is ignored, a resolve --applied row is counted', () => {
  const migrations = chainOf('202610010001_a').migrations
  const rows = [row('202610010001_a', { finished_at: null, rolled_back_at: '2026-10-01T00:00:02Z' }), row('202610010001_a', { applied_steps_count: 0 })]
  const { failures, summary } = checkHistory(rows, migrations, { phase: 'before' })
  assert.deepEqual(failures, [])
  assert.equal(summary.rolledBackRows, 1)
  assert.equal(summary.resolvedWithoutExecution, 1)
})

test('history after: nothing pending, this run applied the expected set in chain order', () => {
  const migrations = chainOf('202610010001_a', '202610020001_b', '202610030001_c').migrations
  const since = '2026-10-20T00:00:00Z'
  const run = (name, second) => row(name, { started_at: `2026-10-20T00:00:0${second}Z` })
  const good = [row('202610010001_a'), run('202610020001_b', 1), run('202610030001_c', 2)]
  assert.deepEqual(checkHistory(good, migrations, { phase: 'after', since, expectApplied: 2 }).failures, [])
  assert.equal(checkHistory(good, migrations, { phase: 'after', since }).summary.appliedThisRun, 2)
  assert.match(checkHistory(good, migrations, { phase: 'after', since, expectApplied: 3 }).failures.join(), /apply 3 migrations, it applied 2/)
  assert.match(checkHistory([run('202610030001_c', 1), run('202610020001_b', 2), run('202610010001_a', 3)], migrations, { phase: 'after', since }).failures.join(), /differs from the chain order/)
  assert.match(checkHistory([row('202610010001_a')], migrations, { phase: 'after', since }).failures.join(), /still pending/)
})

test('the digest changes when any migration name or checksum changes', () => {
  const base = chainOf('202610010001_a', '202610020001_b').migrations
  assert.notEqual(chainDigest(base), chainDigest([base[0], { ...base[1], checksum: 'other' }]))
  assert.notEqual(chainDigest(base), chainDigest([base[0]]))
})
