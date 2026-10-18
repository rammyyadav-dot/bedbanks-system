import test from 'node:test'
import assert from 'node:assert/strict'
import type { LedgerIntegrityRunsView, LedgerIntegrityRunSummary } from '@bedbanks/contracts'
import { scheduleBanner } from './ledger-integrity-schedule-ui'

const run = (over: Partial<LedgerIntegrityRunSummary> = {}): LedgerIntegrityRunSummary => ({ id: 'r1', runDate: '2026-10-18', status: 'PASS', errors: 0, warnings: 0, truncated: false, accountsScanned: 1, bookingsScanned: 1, entriesScanned: 1, createdAt: '2026-10-18T01:00:00.000Z', ...over })
const view = (over: Partial<LedgerIntegrityRunsView> = {}): LedgerIntegrityRunsView => ({ scheduler: { enabled: true, runHourUtc: 1, overdueAfterHours: 3 }, schedule: 'OK', expectedRunDate: '2026-10-18', latest: run(), runs: [run()], ...over })

test('switched off is stated plainly and is not styled as a failure or as clean', () => {
  const b = scheduleBanner(view({ schedule: 'NEVER_RUN', scheduler: { enabled: false, runHourUtc: 1, overdueAfterHours: 3 }, latest: null, runs: [] }))
  assert.equal(b.tone, 'neutral'); assert.match(b.label, /not switched on/); assert.match(b.detail, /only the live check/)
})

test('switched on but nothing yet is a warning that names the hour', () => {
  const b = scheduleBanner(view({ schedule: 'NEVER_RUN', latest: null, runs: [] }))
  assert.equal(b.tone, 'warn'); assert.match(b.detail, /01:00 UTC/)
})

test('a missing night is red, names the date, and says the ledger is unchecked', () => {
  const b = scheduleBanner(view({ schedule: 'OVERDUE', expectedRunDate: '2026-10-18', latest: run({ runDate: '2026-10-16' }) }))
  assert.equal(b.tone, 'bad'); assert.match(b.detail, /2026-10-18 is missing/); assert.match(b.detail, /latest is 2026-10-16/); assert.match(b.detail, /unchecked/)
})

test('the latest verdict decides the tone when the schedule is current', () => {
  assert.equal(scheduleBanner(view()).tone, 'ok')
  const fail = scheduleBanner(view({ latest: run({ status: 'FAIL', errors: 1, warnings: 2 }) }))
  assert.equal(fail.tone, 'bad'); assert.match(fail.detail, /1 error, 2 warnings/)
  assert.equal(scheduleBanner(view({ latest: run({ status: 'WARN', warnings: 1 }) })).tone, 'warn')
})
