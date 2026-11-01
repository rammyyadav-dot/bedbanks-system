import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate } from './dependency-audit-check.mjs'

const adv = (id, severity, module_name = 'm') => ({ github_advisory_id: id, severity, module_name, title: 't', patched_versions: '>=2' })

test('blocks unaccepted high and critical, ignores moderate and low', () => {
  const problems = evaluate({ 1: adv('GHSA-a', 'critical'), 2: adv('GHSA-b', 'high'), 3: adv('GHSA-c', 'moderate'), 4: adv('GHSA-d', 'low') }, { accepted: [] }, '2026-10-18')
  assert.equal(problems.length, 2)
})

test('an accepted advisory passes until its expiry date', () => {
  const allow = { accepted: [{ advisory: 'GHSA-a', module: 'm', reason: 'r', expires: '2026-12-31' }] }
  assert.deepEqual(evaluate({ 1: adv('GHSA-a', 'high') }, allow, '2026-10-18'), [])
  assert.equal(evaluate({ 1: adv('GHSA-a', 'high') }, allow, '2027-01-01').length, 1)
})

test('an allowlist entry without reason or expiry is itself a failure', () => {
  assert.equal(evaluate({}, { accepted: [{ advisory: 'GHSA-a', module: 'm' }] }, '2026-10-18').length, 1)
})
