import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECON_EXCEPTION_STATUSES, RECON_FINDING_TYPES, RECON_RESOLUTION_ACTIONS, RECON_RUN_STATUSES } from '@bedbanks/contracts'
import { ACTION_LABEL, RUN_ERROR_TEXT, RUN_LABEL, STATUS_LABEL, TYPE_LABEL, runIsActive } from './reconciliation-ui'
import { flatNav } from '../components/layout/nav-config'

const root = join(import.meta.dirname, '..')

test('every contract value has operator-facing text, so the queue can never show a raw enum', () => {
  for (const t of RECON_FINDING_TYPES) assert.ok(TYPE_LABEL[t], t)
  for (const a of RECON_RESOLUTION_ACTIONS) assert.ok(ACTION_LABEL[a], a)
  for (const s of RECON_EXCEPTION_STATUSES) assert.ok(STATUS_LABEL[s], s)
  for (const s of RECON_RUN_STATUSES) assert.ok(RUN_LABEL[s], s)
  for (const code of ['SCOPE_TOO_LARGE', 'MAX_ATTEMPTS', 'RUN_ERROR']) assert.ok(RUN_ERROR_TEXT[code], code)
})

test('only queued and running runs are active', () => {
  assert.equal(runIsActive('QUEUED'), true); assert.equal(runIsActive('RUNNING'), true)
  assert.equal(runIsActive('SUCCEEDED'), false); assert.equal(runIsActive('FAILED'), false); assert.equal(runIsActive(undefined), false)
})

test('reconciliation is a real, permission-gated module that reads its own API and does no money arithmetic', () => {
  const item = flatNav.find((n) => n.href === '/finance/reconciliation')
  assert.ok(item); assert.equal(item.requires, 'finance.read')
  const files = ['app/(dashboard)/finance/reconciliation/page.tsx', 'components/finance/DisputeQueue.tsx', 'components/finance/ExceptionPanel.tsx', 'components/finance/ReconciliationStatements.tsx', 'components/finance/StatementImport.tsx', 'lib/data/finance-reconciliation.ts']
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8')
    assert.doesNotMatch(text, /FeatureUnavailable|mockData|fallbackData|\.catch\(\s*\(\)\s*=>/, f)
    assert.doesNotMatch(text, /BigInt|parseInt|Math\.(round|floor|ceil)|window\.prompt/, `${f}: amounts come from the server as strings; reasons use a form`)
  }
  assert.match(readFileSync(join(root, files[0]), 'utf8'), /finance\.reconcile\.resolve/)
})
