import test from 'node:test'
import assert from 'node:assert/strict'
import { formatMinorUnits, isMinorUnits } from './minor-units'

test('accepts only non-negative integer minor-unit strings', () => {
  assert.equal(isMinorUnits('0'), true)
  assert.equal(isMinorUnits('150000'), true)
  assert.equal(isMinorUnits('10.50'), false)
  assert.equal(isMinorUnits('-1'), false)
  assert.equal(isMinorUnits('1e3'), false)
  assert.equal(isMinorUnits(''), false)
})

test('formats minor units using currency fraction digits without floating point', () => {
  assert.equal(formatMinorUnits('150000', 'USD'), 'USD 1,500.00')
  assert.equal(formatMinorUnits('5', 'AED'), 'AED 0.05')
  assert.equal(formatMinorUnits('1500', 'JPY'), 'JPY 1,500')
  assert.equal(formatMinorUnits('1234', 'KWD'), 'KWD 1.234')
  assert.equal(formatMinorUnits('9007199254740993', 'USD'), 'USD 90,071,992,547,409.93')
  assert.equal(formatMinorUnits('abc', 'USD'), '—')
  assert.equal(formatMinorUnits('100', 'usd'), '—')
})
