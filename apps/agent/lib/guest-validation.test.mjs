import assert from 'node:assert/strict'
import test from 'node:test'
import { leadGuestError } from './guest-validation.ts'

test('requires a lead guest first and last name', () => {
  assert.match(leadGuestError('', 'Khan') ?? '', /first and last name/)
  assert.match(leadGuestError('Amina', '   ') ?? '', /first and last name/)
  assert.equal(leadGuestError('Amina', 'Khan'), null)
  assert.equal(leadGuestError("Mary-Jane", "O'Neil"), null)
})

test('rejects a name that is not letters', () => {
  assert.match(leadGuestError('Amina2', 'Khan') ?? '', /letters/)
  assert.match(leadGuestError('A'.repeat(81), 'Khan') ?? '', /80/)
})
