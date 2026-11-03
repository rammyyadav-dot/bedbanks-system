import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { REQUIRED_RULES, problems } from './secret-scan-gate-check.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const toml = readFileSync(join(root, '.gitleaks.toml'), 'utf8')
const workflow = readFileSync(join(root, '.github/workflows/security.yml'), 'utf8')

test('the committed workflow requires every custom rule on every pull request', () => {
  assert.deepEqual(problems(toml, workflow), [])
  assert.equal(REQUIRED_RULES.length, 7)
})

test('dropping a rule, a path filter, or a count threshold fails the gate', () => {
  assert.equal(problems(toml.replace('id = "fbeds-neon-api-key"', 'id = "other"'), workflow).some((line) => line.includes('fbeds-neon-api-key')), true)
  assert.equal(problems(toml, workflow.replace('fbeds-aws-session-token', 'removed-rule')).some((line) => line.includes('fbeds-aws-session-token')), true)
  assert.equal(problems(toml, `${workflow}\nif [ "$found" -lt 5 ]; then exit 1; fi\n`).some((line) => line.includes('found -lt')), true)
  const filtered = workflow.replace('  pull_request:\n', '  pull_request:\n    paths:\n      - apps/**\n')
  assert.equal(problems(toml, filtered).some((line) => line.includes('path-filtered')), true)
})
