import assert from 'node:assert/strict'
import test from 'node:test'
import { formatNetMinor, NOT_RECORDED } from './format'

const plain = (value: string) => value.replace(/ /g, ' ')

test('a missing net is Not recorded, never zero', () => {
  assert.equal(formatNetMinor(null, 'AED'), NOT_RECORDED)
  assert.equal(formatNetMinor('abc', 'AED'), NOT_RECORDED)
  assert.notEqual(formatNetMinor('0', 'AED'), NOT_RECORDED)
})

test('formats integer minor units with the currency exponent and no float arithmetic', () => {
  assert.equal(plain(formatNetMinor('350000', 'AED')), 'AED 3,500.00')
  assert.equal(plain(formatNetMinor('148600', 'OMR')), 'OMR 148.600')
  assert.equal(plain(formatNetMinor('5', 'AED')), 'AED 0.05')
  assert.equal(plain(formatNetMinor('9007199254740993', 'AED')), 'AED 90,071,992,547,409.93') // beyond Number.MAX_SAFE_INTEGER
})

test('an unsupported currency shows the raw minor units instead of guessing a scale', () => {
  assert.match(formatNetMinor('1234', 'ZZZ'), /1234 minor units \(ZZZ\)/)
})
