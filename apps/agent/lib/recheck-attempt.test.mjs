import assert from 'node:assert/strict'
import test from 'node:test'
import { recheckResultApplies } from './recheck-attempt.ts'

test('applies a recheck only to the attempt that is still selected', () => {
  const attempt = { generation: 2, offerId: 'offer-a' }
  assert.equal(recheckResultApplies(attempt, { generation: 2, offerId: 'offer-a' }), true)
  assert.equal(recheckResultApplies(attempt, { generation: 3, offerId: 'offer-a' }), false)
  assert.equal(recheckResultApplies(attempt, { generation: 2, offerId: 'offer-b' }), false)
  assert.equal(recheckResultApplies(attempt, { generation: 1, offerId: 'offer-b' }), false)
})
