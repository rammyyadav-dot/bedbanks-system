import assert from 'node:assert/strict'
import test from 'node:test'
import { signInErrorMessage } from './sign-in-error.ts'

test('separates invalid credentials, denied access, and retry', () => {
  assert.match(signInErrorMessage(new Error('Invalid credentials')), /Check your credentials/)
  assert.match(signInErrorMessage(new Error('Access denied')), /cannot open the agent workspace/)
  assert.match(signInErrorMessage(new Error('Request failed')), /temporarily unavailable/)
})
