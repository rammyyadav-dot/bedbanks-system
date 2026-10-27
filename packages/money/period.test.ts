import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPeriodTotals, monthRange, periodBlockers, type PeriodBlockerInput } from './src/index.ts'

const range = monthRange('2026-09')!
const base: PeriodBlockerInput = { range, now: new Date('2026-10-05T00:00:00Z'), alreadyClosed: false, lastClosedEnd: range.start, earliestEntryAt: new Date('2026-08-15T00:00:00Z'), verdict: 'CLEAN' }

test('a month is the UTC range from its first day to the first day of the next, across a year end', () => {
  assert.equal(range.start.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.equal(range.end.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(monthRange('2026-12')!.end.toISOString(), '2027-01-01T00:00:00.000Z')
  for (const bad of ['2026-13', '2026-00', '2026-9', '26-09', '2026-09-01', '', '1999-12']) assert.equal(monthRange(bad), null)
})

test('a closable month has no blockers', () => assert.deepEqual(periodBlockers(base), []))

test('the month must have ended, with a grace so an in-flight posting is not missed', () => {
  assert.deepEqual(periodBlockers({ ...base, now: new Date('2026-09-30T12:00:00Z') }), ['PERIOD_NOT_ENDED'])
  assert.deepEqual(periodBlockers({ ...base, now: new Date('2026-10-01T00:04:00Z') }), ['PERIOD_NOT_ENDED'])
  assert.deepEqual(periodBlockers({ ...base, now: new Date('2026-10-01T00:05:00Z') }), [])
})

test('periods close in order: the next starts where the last ended, the first is the month of the earliest entry', () => {
  assert.deepEqual(periodBlockers({ ...base, lastClosedEnd: new Date('2026-08-01T00:00:00Z') }), ['PERIOD_NOT_NEXT'])
  assert.deepEqual(periodBlockers({ ...base, lastClosedEnd: null }), ['PERIOD_NOT_NEXT'])
  assert.deepEqual(periodBlockers({ ...base, lastClosedEnd: null, earliestEntryAt: new Date('2026-09-20T10:00:00Z') }), [])
  assert.deepEqual(periodBlockers({ ...base, lastClosedEnd: null, earliestEntryAt: null }), [])
})

test('a closed month is reported once, not as out of order', () => assert.deepEqual(periodBlockers({ ...base, alreadyClosed: true, lastClosedEnd: range.end }), ['PERIOD_ALREADY_CLOSED']))

test('critical findings and an incomplete scan block; warnings do not', () => {
  assert.deepEqual(periodBlockers({ ...base, verdict: 'ISSUES' }), ['INTEGRITY_ISSUES'])
  assert.deepEqual(periodBlockers({ ...base, verdict: 'INCOMPLETE' }), ['INTEGRITY_INCOMPLETE'])
  assert.deepEqual(periodBlockers({ ...base, verdict: 'WARNINGS' }), [])
})

test('control totals tie per currency and never mix currencies', () => {
  const totals = buildPeriodTotals({
    opening: [{ currency: 'AED', sumMinor: 1000n }],
    movements: [{ currency: 'AED', type: 'CREDIT', entries: 2, sumMinor: 500n }, { currency: 'AED', type: 'DEBIT', entries: 1, sumMinor: -200n }, { currency: 'USD', type: 'CREDIT', entries: 1, sumMinor: 70n }],
    closing: [{ currency: 'AED', sumMinor: 1300n }, { currency: 'USD', sumMinor: 70n }],
  })
  assert.deepEqual(totals.map(t => [t.currency, t.entries, t.openingMinor, t.movementMinor, t.closingMinor]), [['AED', 3, 1000n, 300n, 1300n], ['USD', 1, 0n, 70n, 70n]])
  assert.deepEqual(totals[0].byType.map(b => b.type), ['CREDIT', 'DEBIT'])
})

test('totals that do not tie are refused, not returned', () => {
  assert.throws(() => buildPeriodTotals({ opening: [{ currency: 'AED', sumMinor: 1000n }], movements: [{ currency: 'AED', type: 'CREDIT', entries: 1, sumMinor: 500n }], closing: [{ currency: 'AED', sumMinor: 1499n }] }), /do not tie for AED/)
})

test('a currency with only an opening balance carries it through', () => {
  const [row] = buildPeriodTotals({ opening: [{ currency: 'AED', sumMinor: 40n }], movements: [], closing: [{ currency: 'AED', sumMinor: 40n }] })
  assert.deepEqual([row.entries, row.movementMinor, row.closingMinor], [0, 0n, 40n])
})
