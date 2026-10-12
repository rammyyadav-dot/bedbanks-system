import test from 'node:test'
import assert from 'node:assert/strict'
import { badCodes, formatCodeList, parseCodeList } from './market-list'

test('parses, upper-cases and de-duplicates', () => { assert.deepEqual(parseCodeList(' ae, in ,AE,,'), ['AE', 'IN']) })
test('a blank field is an empty list, meaning no extra restriction', () => { assert.deepEqual(parseCodeList('  '), []) })
test('formats a stored list back, tolerating null from older rows', () => {
  assert.equal(formatCodeList(['AE', 'IN']), 'AE, IN')
  assert.equal(formatCodeList(null), '')
})
test('flags anything that is not two letters', () => { assert.deepEqual(badCodes(['AE', 'ARE', 'A1']), ['ARE', 'A1']) })
