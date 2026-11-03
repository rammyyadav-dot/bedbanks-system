import assert from 'node:assert/strict'
import test from 'node:test'
import { check } from './env-examples-check.mjs'

test('accepts empty, placeholder, local and numeric values', () => {
  const text = `API_PORT=3002
DATABASE_URL=postgresql://fbeds_api_login:CHANGE_ME_generated_password@localhost:5432/fbeds_dev
FBEDS_LEAD_SIGNING_SECRET=
# HOLD_EXPIRY_DATABASE_URL=<secret reference; never commit a real value>
ADMIN_ORIGIN=http://localhost:3001
NEXT_PUBLIC_CONTACT_EMAIL=book@fabbeds.io
`
  assert.deepEqual(check('x', text), [])
})

test('rejects embedded passwords, remote hosts and token-like values', () => {
  // Low-entropy stand-ins: they still fail this checker, and they must not be detectable secrets (gitleaks scans this file).
  assert.equal(check('x', 'DATABASE_URL=postgresql://u:pw@ep-1.neon.tech/db').length, 1)
  assert.equal(check('x', 'API_URL=https://api.supplier.com/v1').length, 1)
  assert.equal(check('x', `SOME_KEY=${'a'.repeat(24)}`).length, 1)
  assert.equal(check('x', 'SESSION_SECRET=hunter2').length, 1)
  assert.equal(check('x', `# LEDGER_TOKEN=${'b'.repeat(24)}`).length, 1)
})
