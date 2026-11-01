import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceChange, signedPercentToBp } from './quick-update-price'

test('signed percent converts to basis points without floats', () => {
  assert.equal(signedPercentToBp('+5'), 500); assert.equal(signedPercentToBp('-3.5'), -350); assert.equal(signedPercentToBp('12.25'), 1225)
  assert.equal(signedPercentToBp('1.234'), null); assert.equal(signedPercentToBp('abc'), null)
})

test('each price mode builds its request; blank is no change (ADR 0067, F-14)', () => {
  const base = { amount: '', basis: 'SELL' as const, adjust: '', seasons: [] }
  assert.deepEqual(priceChange('SET', { ...base, amount: ' 450 ' }), { amount: '450', basis: 'SELL' })
  assert.equal(priceChange('SET', base), null)
  assert.deepEqual(priceChange('PERCENT', { ...base, adjust: '-10', occupancy: 1 }), { adjustPercentBp: -1000, occupancy: 1 })
  assert.deepEqual(priceChange('AMOUNT', { ...base, adjust: '+25.00' }), { adjustAmount: '+25.00' })
  assert.deepEqual(priceChange('SEASONS', { ...base, seasons: [{ from: '2026-12-20', to: '2027-01-05', amount: '900' }, { from: '', to: '', amount: '' }] }), { seasons: [{ from: '2026-12-20', to: '2027-01-05', amount: '900' }], basis: 'SELL' })
})
