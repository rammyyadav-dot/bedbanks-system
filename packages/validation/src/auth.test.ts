import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loginRequestSchema, passwordResetConfirmSchema } from './auth.ts'

test('login accepts a work email and rejects a tenant field', () => {
  const parsed = loginRequestSchema.parse({ email: 'agent@example.test', password: 'secret' })
  assert.equal(parsed.email, 'agent@example.test')
  assert.equal(loginRequestSchema.safeParse({ email: 'not-an-email', password: 'secret' }).success, false)
  assert.equal(loginRequestSchema.safeParse({ email: 'agent@example.test', password: 'secret', tenantId: 't1' }).success, false)
})

test('password reset confirm requires a 64-character hex token', () => {
  const token = 'a'.repeat(64)
  assert.equal(passwordResetConfirmSchema.safeParse({ token, newPassword: 'long-enough' }).success, true)
  assert.equal(passwordResetConfirmSchema.safeParse({ token: 'short', newPassword: 'long-enough' }).success, false)
})
