import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMinorUnits, majorUnitsToMinor, minorUnitsToMajorInput } from './src/index.ts'

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

test('converts major units with the currency exponent and never a float', () => {
  assert.equal(majorUnitsToMinor('100', 'AED'), 10000)
  assert.equal(majorUnitsToMinor('100.00', 'USD'), 10000)
  assert.equal(majorUnitsToMinor('100.50', 'AED'), 10050)
  assert.equal(majorUnitsToMinor('100.000', 'OMR'), 100000)
  assert.equal(majorUnitsToMinor('100.5', 'OMR'), 100500)
  assert.equal(majorUnitsToMinor('100', 'JPY'), 100)
  assert.equal(minorUnitsToMajorInput(10000, 'AED'), '100')
  assert.equal(minorUnitsToMajorInput(10050, 'USD'), '100.50')
  assert.equal(minorUnitsToMajorInput(100000, 'OMR'), '100')
  assert.equal(minorUnitsToMajorInput(100500, 'OMR'), '100.500')
  assert.throws(() => majorUnitsToMinor('100.501', 'AED'), /scale/)
  assert.throws(() => majorUnitsToMinor('100.0001', 'OMR'), /scale/)
  assert.throws(() => majorUnitsToMinor('100.5', 'JPY'), /scale/)
  assert.equal(Number.isInteger(majorUnitsToMinor('100.50', 'USD')), true)
})
