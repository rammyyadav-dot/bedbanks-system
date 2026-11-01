import test from 'node:test'
import assert from 'node:assert/strict'
import { basisPointsToSignedPercent, buildDerivationInput, describeDerivation, signedMajorToMinor, signedPercentToBasisPoints } from './derivation'

const v = '2026-10-12T08:00:00.000Z'

test('signed percent text becomes integer basis points without floating point', () => {
  assert.equal(signedPercentToBasisPoints('-10'), -1000)
  assert.equal(signedPercentToBasisPoints('12.5'), 1250)
  assert.equal(signedPercentToBasisPoints('+5'), 500)
  assert.equal(signedPercentToBasisPoints('0'), 0)
  assert.equal(signedPercentToBasisPoints('-0.07'), -7)
  assert.equal(signedPercentToBasisPoints('1.234'), null)
  assert.equal(signedPercentToBasisPoints('abc'), null)
  assert.equal(basisPointsToSignedPercent(-1250), '-12.5')
  assert.equal(basisPointsToSignedPercent(500), '5')
})

test('signed major units become integer minor units for the currency', () => {
  assert.equal(signedMajorToMinor('-25.50', 'AED'), -2550)
  assert.equal(signedMajorToMinor('25', 'AED'), 2500)
  assert.equal(signedMajorToMinor('25.555', 'AED'), null)
  assert.equal(signedMajorToMinor('5000', 'JPY'), 5000)
  assert.equal(signedMajorToMinor('99999999999', 'AED'), null)
})

test('a percent derivation builds the API input', () => {
  const r = buildDerivationInput({ parentId: 'p1', mode: 'PERCENT_BP', amount: '-10' }, 'AED', v)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.input, { expectedUpdatedAt: v, parentId: 'p1', mode: 'PERCENT_BP', adjustment: -1000 })
})

test('a fixed derivation builds the API input in minor units', () => {
  assert.deepEqual(buildDerivationInput({ parentId: 'p1', mode: 'FIXED_MINOR', amount: '25.5' }, 'AED', v).input, { expectedUpdatedAt: v, parentId: 'p1', mode: 'FIXED_MINOR', adjustment: 2550 })
})

test('mistakes are reported and nothing is built', () => {
  assert.equal(buildDerivationInput({ parentId: '', mode: 'PERCENT_BP', amount: '-10' }, 'AED', v).input, null)
  assert.match(buildDerivationInput({ parentId: 'p', mode: 'PERCENT_BP', amount: '-95' }, 'AED', v).problems.join(' '), /-90%/)
  assert.match(buildDerivationInput({ parentId: 'p', mode: 'PERCENT_BP', amount: 'ten' }, 'AED', v).problems.join(' '), /percent/)
  assert.match(buildDerivationInput({ parentId: 'p', mode: 'FIXED_MINOR', amount: '1.234' }, 'AED', v).problems.join(' '), /AED amount/)
})

test('a derivation reads as one plain sentence', () => {
  assert.equal(describeDerivation({ parentCode: 'BAR', mode: 'PERCENT_BP', adjustment: -1000 }, 'AED'), '10% below BAR')
  assert.equal(describeDerivation({ parentCode: 'BAR', mode: 'FIXED_MINOR', adjustment: 2550 }, 'AED'), 'AED 25.50 above BAR')
  assert.equal(describeDerivation({ parentCode: 'BAR', mode: 'PERCENT_BP', adjustment: 0 }, 'AED'), 'Same price as BAR')
})
