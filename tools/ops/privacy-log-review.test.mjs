import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reviewSource } from './privacy-log-review.mjs'

test('a log of a password is a finding and a redaction comment is not', () => {
  const findings = reviewSource([
    ['apps/api/src/auth/session.ts', 'this.logger.error(`password=${secret}`)'],
    ['apps/api/src/auth/safe.ts', 'this.logger.error("password redacted")'],
    ['apps/api/src/database/provision.ts', "console.log('store the password in the secret manager and never commit it')"],
  ])
  assert.equal(findings.length, 1)
  assert.equal(findings[0].file, 'apps/api/src/auth/session.ts')
})
