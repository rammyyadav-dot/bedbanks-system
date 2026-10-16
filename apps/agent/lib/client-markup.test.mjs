import assert from 'node:assert/strict'
import test from 'node:test'
import { clientPrice, formatMarkupPercent, parseMarkupPercent, readClientMarkup, rememberClientMarkup, stepMarkup } from './client-markup.ts'

test('markup percent text becomes integer basis points without floating point; out of range is refused', () => {
  assert.deepEqual(parseMarkupPercent(''), { ok: true, basisPoints: 0 })
  assert.deepEqual(parseMarkupPercent('10'), { ok: true, basisPoints: 1000 })
  assert.deepEqual(parseMarkupPercent('12.5'), { ok: true, basisPoints: 1250 })
  assert.deepEqual(parseMarkupPercent('0.01'), { ok: true, basisPoints: 1 })
  assert.deepEqual(parseMarkupPercent('50'), { ok: true, basisPoints: 5000 })
  for (const bad of ['50.01', '51', '-1', '1.234', 'abc', '1e2', '100']) assert.equal(parseMarkupPercent(bad).ok, false, bad)
  assert.equal(formatMarkupPercent(1250), '12.5')
  assert.equal(formatMarkupPercent(1000), '10')
  assert.equal(formatMarkupPercent(1), '0.01')
  assert.equal(stepMarkup(4950, 1), 5000)
  assert.equal(stepMarkup(50, -1), 0)
  assert.equal(stepMarkup(1000, 1), 1100)
})

test('client price: the brief example (net 100.00 + 10% = 110.00), half-up rounding, and no markup means no client price', () => {
  assert.deepEqual(clientPrice({ amountMinor: 10000, currency: 'USD' }, 1000), { amountMinor: 11000, currency: 'USD' })
  assert.deepEqual(clientPrice({ amountMinor: 90000, currency: 'AED' }, 1250), { amountMinor: 101250, currency: 'AED' })
  assert.deepEqual(clientPrice({ amountMinor: 333, currency: 'AED' }, 150), { amountMinor: 338, currency: 'AED' }) // 4.995 -> 5
  assert.equal(clientPrice({ amountMinor: 10000, currency: 'USD' }, 0), null)
  assert.equal(clientPrice({ amountMinor: 10000, currency: 'USD' }, 5001), null)
  assert.equal(clientPrice({ amountMinor: 10.5, currency: 'USD' }, 1000), null)
})

test('the markup is remembered per user and tenant, and broken storage never breaks the page', () => {
  const values = new Map()
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) }
  rememberClientMarkup(storage, 'u1', 't1', 1500)
  assert.equal(readClientMarkup(storage, 'u1', 't1'), 1500)
  assert.equal(readClientMarkup(storage, 'u1', 't2'), 0)
  rememberClientMarkup(storage, 'u1', 't1', 0)
  assert.equal(readClientMarkup(storage, 'u1', 't1'), 0)
  values.set('fbeds:agent:client-markup:t1:u1', '99999')
  assert.equal(readClientMarkup(storage, 'u1', 't1'), 0)
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
  assert.equal(readClientMarkup(broken, 'u1', 't1'), 0)
  assert.doesNotThrow(() => rememberClientMarkup(broken, 'u1', 't1', 100))
})
