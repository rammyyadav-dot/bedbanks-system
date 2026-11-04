import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { reviewIncidentRunbook } from './incident-tabletop.mjs'

const runbook = readFileSync(new URL('../../docs/runbooks/incident-response.md', import.meta.url), 'utf8')

test('the incident runbook answers the tabletop', () => {
  const result = reviewIncidentRunbook(runbook)
  assert.deepEqual(result.problems, [])
  assert.equal(result.scenarios.find((s) => s.id === 'data-loss').severity, 1)
  assert.equal(result.scenarios.find((s) => s.id === 'supplier-outage').severity, 2)
})

test('a runbook that restores over the live instance fails the drill', () => {
  const weakened = runbook.replace('Never restore over the live instance', 'restore over the live instance')
  const result = reviewIncidentRunbook(weakened)
  assert.equal(result.pass, false)
  assert.match(result.problems.join('\n'), /data-loss/)
})
