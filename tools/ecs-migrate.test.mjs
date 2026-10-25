// Tests for scripts/ecs-migrate.sh with a stub `aws`: no network, no AWS. Proves it pins the commit's migrator digest and fails closed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = 'scripts/ecs-migrate.sh'
const SHA = 'a'.repeat(40)
const DIGEST = `sha256:${'b'.repeat(64)}`
const TD = JSON.stringify({ family: 'fbeds-staging-migrate', taskDefinitionArn: 'arn:aws:ecs:ap-south-1:111111111111:task-definition/fbeds-staging-migrate:1', revision: 1, status: 'ACTIVE', containerDefinitions: [{ name: 'migrate', image: 'x/fbeds/api:old-migrate' }] })
const NET = JSON.stringify({ subnets: ['subnet-1', 'subnet-2'], securityGroups: ['sg-1'], assignPublicIp: 'DISABLED' })

function setup({ exitCode = '0', digest = DIGEST } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecsmig-')); const bin = join(dir, 'bin'); mkdirSync(bin)
  const log = join(dir, 'calls.log'); const registered = join(dir, 'registered.json')
  writeFileSync(join(dir, 'td.json'), TD); writeFileSync(join(dir, 'net.json'), NET)
  writeFileSync(join(bin, 'aws'), `#!/bin/bash
echo "aws $*" >> "${log}"
case "$*" in
  *"sts get-caller-identity"*) echo 111111111111 ;;
  *"ecr describe-images"*) if [ "${digest}" = none ]; then exit 254; fi; echo "${digest}" ;;
  *"ecs describe-task-definition"*) cat "${join(dir, 'td.json')}" ;;
  *"ecs describe-services"*) cat "${join(dir, 'net.json')}" ;;
  *"ecs register-task-definition"*) cp "\${@: -1}" /dev/null 2>/dev/null; for a in "$@"; do case "$a" in file://*) cp "\${a#file://}" "${registered}" ;; esac; done; echo arn:aws:ecs:ap-south-1:111111111111:task-definition/fbeds-staging-migrate:2 ;;
  *"ecs run-task"*) echo arn:aws:ecs:ap-south-1:111111111111:task/fbeds-staging/abc123 ;;
  *"ecs wait"*) exit 0 ;;
  *"ecs describe-tasks"*) printf '%s\\t%s\\n' "${exitCode}" "None" ;;
esac
`)
  chmodSync(join(bin, 'aws'), 0o755)
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, AWS_REGION: 'ap-south-1', TMPDIR: dir }
  return { log, registered, run: (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env }) }
}
const calls = (s) => (existsSync(s.log) ? readFileSync(s.log, 'utf8') : '')

test('rejects a bad environment and a short sha before calling AWS', () => {
  const s = setup()
  assert.equal(s.run('qa', SHA).status, 2)
  const r = s.run('staging', 'abc123'); assert.equal(r.status, 2); assert.match(r.stderr, /40-character/); assert.equal(calls(s), '')
})
test('fails when the commit has no migrator image', () => {
  const s = setup({ digest: 'none' }); const r = s.run('staging', SHA)
  assert.equal(r.status, 1); assert.match(r.stderr, /no fbeds\/api:.*-migrate/); assert.doesNotMatch(calls(s), /run-task/)
})
test('dry run reads but never registers or runs', () => {
  const s = setup(); const r = s.run('staging', SHA, '--dry-run')
  assert.equal(r.status, 0); assert.match(r.stdout, /dry run/); assert.doesNotMatch(calls(s), /register-task-definition|run-task/)
})
test('registers a revision pinned to the commit digest, runs it in the api network, and succeeds on exit 0', () => {
  const s = setup(); const r = s.run('staging', SHA)
  assert.equal(r.status, 0, r.stderr)
  const td = JSON.parse(readFileSync(s.registered, 'utf8'))
  assert.match(td.containerDefinitions[0].image, new RegExp(`fbeds/api@${DIGEST}$`))
  assert.equal(td.revision, undefined); assert.equal(td.taskDefinitionArn, undefined)
  assert.match(calls(s), /subnets=\[subnet-1,subnet-2\],securityGroups=\[sg-1\],assignPublicIp=DISABLED/)
})
test('a non-zero container exit fails the run', () => {
  const s = setup({ exitCode: '1' }); const r = s.run('staging', SHA)
  assert.equal(r.status, 1); assert.match(r.stderr, /migration FAILED/)
})
