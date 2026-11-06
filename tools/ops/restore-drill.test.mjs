// The restore drill refuses anything that is not a loopback PostgreSQL. It does not connect for that refusal.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

test('restore drill refuses a non-loopback source before connecting', () => {
  const result = spawnSync('bash', ['tools/ops/restore-drill.sh'], {
    encoding: 'utf8',
    env: { ...process.env, SOURCE_URL: 'postgresql://postgres:postgres@db.internal:5432/fbeds' },
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /refusing non-loopback host 'db.internal'/)
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /PASS/)
})

test('restore drill requires a source URL', () => {
  const result = spawnSync('bash', ['tools/ops/restore-drill.sh'], {
    encoding: 'utf8',
    env: { ...process.env, SOURCE_URL: '' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SOURCE_URL/)
})
