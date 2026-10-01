import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMoney } from './format'
import { getSupplierAdapter } from './adapter'
import { getSupplyWorkflowAvailability } from './supply-api'

test('formats OMR 148600 as 148.600', () => {
  assert.equal(formatMoney(148600, 'OMR').replace(/\u00a0/g, ' '), 'OMR 148.600')
})

test('formats AED with two decimals', () => {
  assert.equal(formatMoney(2500, 'AED').replace(/\u00a0/g, ' '), 'AED 25.00')
})

test('mock adapter is not a runtime data source', () => {
  assert.throws(() => getSupplierAdapter(), /mock adapter/)
})

test('unsupported modules stay unavailable when a public API URL is set', () => {
  process.env.NEXT_PUBLIC_API_URL = 'http://localhost:3002/api/v1'
  assert.equal(getSupplyWorkflowAvailability().status, 'unavailable')
  delete process.env.NEXT_PUBLIC_API_URL
})
