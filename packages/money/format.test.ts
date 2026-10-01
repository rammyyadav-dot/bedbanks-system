import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMinorUnits } from './src/index.ts'

test('formats OMR payable minor units with three decimal places', () => {
  const formatted = formatMinorUnits(148600, 'OMR', 'en-GB').replace(/\u00a0/g, ' ')
  assert.equal(formatted, 'OMR 148.600')
})

test('formats AED with two decimal places', () => {
  const formatted = formatMinorUnits(1050, 'AED', 'en-GB').replace(/\u00a0/g, ' ')
  assert.equal(formatted, 'AED 10.50')
})

test('rejects an unsupported currency instead of assuming two decimals', () => {
  assert.throws(() => formatMinorUnits(100, 'XYZ'), /Unsupported currency/)
})
