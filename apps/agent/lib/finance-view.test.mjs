import assert from 'node:assert/strict'
import test from 'node:test'
import { financeCreditLabel, nextFinanceView } from './finance-view.ts'

test('Given a live balance, When a later refresh fails, Then the old amount is not presented as current', () => {
  const ready = nextFinanceView({ phase: 'loading', summary: null }, { ok: true, summary: { availableCredit: '100' } })
  const stale = nextFinanceView(ready, { ok: false, denied: false })
  assert.equal(stale.phase, 'stale')
  assert.equal(stale.summary, null)
  assert.equal(financeCreditLabel(stale.phase, 'AED 1.00'), 'Balance unavailable')
})

test('Given no previous balance, When the first load fails, Then the balance is unavailable', () => {
  const view = nextFinanceView({ phase: 'loading', summary: null }, { ok: false, denied: false })
  assert.equal(view.phase, 'unavailable')
  assert.equal(financeCreditLabel(view.phase, null), 'Not configured')
})

test('Given a role without finance access, When the summary is denied, Then the denial is not shown as a stale balance', () => {
  const view = nextFinanceView({ phase: 'loading', summary: null }, { ok: false, denied: true })
  assert.equal(view.phase, 'denied')
  assert.equal(financeCreditLabel(view.phase, null), 'Not included in your access')
})
