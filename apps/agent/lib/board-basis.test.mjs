import assert from 'node:assert/strict'
import test from 'node:test'
import { includesBreakfast } from './board-basis.ts'

test('breakfast badge matches known breakfast boards only', () => {
  assert.equal(includesBreakfast('Room Only'), false)
  assert.equal(includesBreakfast('Breakfast'), true)
  assert.equal(includesBreakfast('Bed & Breakfast'), true)
  assert.equal(includesBreakfast('Bed and Breakfast'), true)
  assert.equal(includesBreakfast('Half Board'), false)
  assert.equal(includesBreakfast('No Breakfast'), false)
  assert.equal(includesBreakfast('No breakfast included'), false)
  assert.equal(includesBreakfast('Room Only Breakfast'), false)
})
