import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STATEMENT, evaluateSignoff } from './staging-signoff.mjs'

const sha = 'a'.repeat(40)
const signature = (role, name = 'Amina Rahman') => ({ role, name, signedAt: '2026-11-04T18:00:00+05:30', statement: STATEMENT })

test('four distinct roles on the deployed SHA close the gate', () => {
  const doc = { sha, signatures: ['engineering', 'operations', 'security', 'product'].map((role) => signature(role, `Owner ${role}`)) }
  assert.deepEqual(evaluateSignoff(doc, sha), { status: 'SIGNED', problems: [] })
})

test('a missing record, a wrong SHA, a repeated role or a placeholder name leaves the gate open', () => {
  assert.equal(evaluateSignoff(null, sha).status, 'OPEN')
  const doc = { sha: 'b'.repeat(40), signatures: ['engineering', 'operations', 'security', 'product'].map((role) => signature(role)) }
  assert.match(evaluateSignoff(doc, sha).problems.join('\n'), /sha/)
  const named = { sha, signatures: [signature('engineering', 'cursor'), signature('engineering')] }
  assert.match(evaluateSignoff(named, sha).problems.join('\n'), /accountable name|duplicate role|missing/)
})
