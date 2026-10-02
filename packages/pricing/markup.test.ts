import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPercentMarkup, markupMinor, MAX_MARKUP_BASIS_POINTS } from './src/index.ts'

test('markup is integer minor units, rounded half up', () => {
  assert.equal(markupMinor(10_000n, 1_000), 1_000n)   // ten percent of one hundred
  assert.equal(markupMinor(10_005n, 1_000), 1_001n)   // a half rounds up
  assert.equal(markupMinor(10_004n, 1_000), 1_000n)   // below a half rounds down
  assert.equal(markupMinor(1n, 5_000), 1n)            // exactly a half rounds up
  assert.equal(markupMinor(1n, 4_999), 0n)            // just below a half rounds down
  assert.equal(markupMinor(0n, 2_500), 0n)
  assert.equal(markupMinor(45_000n, 0), 0n)
})

test('large amounts stay exact beyond the safe-integer range', () => {
  const net = 9_007_199_254_740_993n // 2^53 + 1, not representable as a Number
  assert.equal(markupMinor(net, 10_000), net)
  assert.equal(markupMinor(10_000_000_000_000_000n, 1_250), 1_250_000_000_000_000n)
})

test('rejects invalid input instead of rounding it away', () => {
  for (const bp of [-1, 3 / 2, Number.NaN, MAX_MARKUP_BASIS_POINTS + 1]) assert.throws(() => markupMinor(100n, bp), /basis points/)
  assert.throws(() => markupMinor(-1n, 100), /negative/)
})

test('applyPercentMarkup keeps the currency and matches markupMinor', () => {
  assert.deepEqual(applyPercentMarkup({ amountMinor: 45_000, currency: 'AED' }, 1_250), { amountMinor: 50_625, currency: 'AED' })
})
