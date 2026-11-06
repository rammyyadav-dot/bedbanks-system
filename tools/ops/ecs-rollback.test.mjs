// Proves tools/ops/ecs-rollback.sh against a stub aws. No network and no AWS account.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const SCRIPT = 'tools/ops/ecs-rollback.sh'
const DIGEST = `111111111111.dkr.ecr.ap-south-1.amazonaws.com/fbeds/api@sha256:${'ab'.repeat(32)}`
const TAGGED = '111111111111.dkr.ecr.ap-south-1.amazonaws.com/fbeds/api:latest'

function setup({ mode = 'ok', image = DIGEST, status = 'ACTIVE', running = '2', desired = '2', deployments = '1', revs = [7, 5, 3] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-rollback-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const log = join(dir, 'calls.log')
  const summary = join(dir, 'summary.md')
  const runningFile = join(dir, 'running')
  writeFileSync(runningFile, '5')
  const arns = revs.map((rev) => `arn:aws:ecs:ap-south-1:111111111111:task-definition/fbeds-staging-api:${rev}`).join(' ')
  writeFileSync(join(bin, 'aws'), `#!/bin/bash
echo "aws $*" >> "${log}"
args="$*"
if [[ "$args" == *list-task-definitions* ]]; then
  printf '%s\\n' ${arns} | paste -sd $'\\t' -
elif [[ "$args" == *describe-task-definition* ]]; then
  rev=$(printf '%s\\n' "$args" | sed -n 's/.*task-definition fbeds-staging-api:\\([0-9][0-9]*\\).*/\\1/p')
  printf '%s\\t%s\\t%s\\n' "arn:aws:ecs:ap-south-1:111111111111:task-definition/fbeds-staging-api:$rev" "${status}" "${image}"
elif [[ "$args" == *update-service* ]]; then
  rev="\${args##*:}"
  echo "$rev" > "${runningFile}"
  if [ "${mode}" = bounce ]; then echo 5 > "${runningFile}"; fi
elif [[ "$args" == *services\\[0\\].taskDefinition* ]]; then
  rev=$(cat "${runningFile}")
  echo "arn:aws:ecs:ap-south-1:111111111111:task-definition/fbeds-staging-api:$rev"
elif [[ "$args" == *runningCount* ]]; then
  printf '%s\\t%s\\t%s\\n' "${running}" "${desired}" "${deployments}"
elif [[ "$args" == *wait\\ services-stable* ]]; then
  exit 0
else
  echo "unexpected: $args" >> "${log}"
  exit 9
fi
`)
  chmodSync(join(bin, 'aws'), 0o755)
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: process.env.HOME,
    CLUSTER: 'fbeds-staging',
    SERVICE: 'api',
    ACTOR: 'release-owner',
    REASON: 'five minutes of API 5xx',
    REVISION: '',
    GITHUB_STEP_SUMMARY: summary,
  }
  return {
    summary,
    log,
    run: (extra = {}) => spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...env, ...extra } }),
  }
}

const calls = (s) => readFileSync(s.log, 'utf8')

test('restores the previous digest-pinned revision and records who and why', () => {
  const s = setup()
  const r = s.run()
  assert.equal(r.status, 0, r.stderr)
  assert.match(calls(s), /update-service .* --task-definition arn:aws:ecs:ap-south-1:111111111111:task-definition\/fbeds-staging-api:3/)
  assert.match(calls(s), /wait services-stable/)
  assert.doesNotMatch(calls(s), /\brds\b|\bsns\b/)
  const summary = readFileSync(s.summary, 'utf8')
  assert.match(summary, /from revision 5 to 3/)
  assert.match(summary, /requested by release-owner/)
  assert.match(summary, /five minutes of API 5xx/)
  assert.match(summary, new RegExp(DIGEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('an explicit revision is used when it is active and digest-pinned', () => {
  const s = setup()
  const r = s.run({ REVISION: '7' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(calls(s), /task-definition\/fbeds-staging-api:7/)
  assert.doesNotMatch(calls(s), /list-task-definitions/)
})

test('refuses a non-numeric revision before calling AWS', () => {
  const s = setup()
  const r = s.run({ REVISION: 'latest' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /revision must be a number/)
  assert.throws(() => calls(s))
})

test('refuses an image that is not pinned to a digest and does not update the service', () => {
  const s = setup({ image: TAGGED })
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not pinned to a digest/)
  assert.doesNotMatch(calls(s), /update-service/)
})

test('refuses a revision that is already running', () => {
  const s = setup()
  const r = s.run({ REVISION: '5' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /already running/)
  assert.doesNotMatch(calls(s), /update-service/)
})

test('refuses an inactive revision', () => {
  const s = setup({ status: 'INACTIVE' })
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /is INACTIVE/)
  assert.doesNotMatch(calls(s), /update-service/)
})

test('a circuit-breaker bounce is a failed rollback', () => {
  const s = setup({ mode: 'bounce' })
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /did not settle/)
})

test('a service that is not fully rolled fails', () => {
  const s = setup({ running: '1', desired: '2', deployments: '2' })
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not fully rolled: running=1 desired=2 deployments=2/)
})

test('there is no earlier revision to restore', () => {
  const s = setup({ revs: [5] })
  const r = s.run()
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no earlier ACTIVE revision/)
  assert.doesNotMatch(calls(s), /update-service/)
})

test('refuses an unknown cluster or service before calling AWS', () => {
  const s = setup()
  assert.match(s.run({ CLUSTER: 'fbeds-other' }).stderr, /CLUSTER must be/)
  assert.match(s.run({ SERVICE: 'postgres' }).stderr, /SERVICE must be/)
})
