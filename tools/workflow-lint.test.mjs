// Regression for ci.yml:167 (SC2034): the workflow lint must reject an unused loop variable, and must not pass when ShellCheck is absent.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const actionlint = process.env.ACTIONLINT || 'actionlint'
const wf = (loop) => `name: t\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${loop}\n`
const lint = (body, env = process.env) => {
  const f = join(mkdtempSync(join(tmpdir(), 'wf-')), 'w.yml')
  writeFileSync(f, wf(body))
  return spawnSync(actionlint, ['-color=false', f], { encoding: 'utf8', env })
}

test('unused loop variable is rejected (SC2034)', () => {
  const r = lint('for i in $(seq 1 3); do sleep 1; done')
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SC2034/)
})
test('underscore loop variable is accepted', () => assert.equal(lint('for _ in $(seq 1 3); do sleep 1; done').status, 0))
test('workflow-lint.sh refuses to pass without shellcheck', () => {
  // /usr/bin:/bin has bash and git but (on CI and here) not shellcheck; the failure must be the explicit shellcheck refusal, not an unrelated one.
  const r = spawnSync('/bin/bash', ['tools/workflow-lint.sh', actionlint], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } })
  if (/(^|\n)shellcheck\b/.test(spawnSync('/bin/sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout)) return // shellcheck lives in /usr/bin here: cannot hide it
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /shellcheck not found/)
})
