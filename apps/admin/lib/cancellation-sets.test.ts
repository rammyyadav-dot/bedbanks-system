import test from 'node:test'
import assert from 'node:assert/strict'
import { groupRules, setFromInput, setNames } from './cancellation-sets'

const rules = [{ id: 1, policySet: null }, { id: 2 }, { id: 3, policySet: 'STRICT' }, { id: 4, policySet: 'FLEX' }, { id: 5, policySet: 'STRICT' }]

test('named sets are distinct and sorted; the default is not a name', () => { assert.deepEqual(setNames(rules), ['FLEX', 'STRICT']) })
test('rules group with the default first, legacy rows without the field counted as default', () => {
  const groups = groupRules(rules)
  assert.deepEqual(groups.map((g) => [g.set, g.rules.length]), [[null, 2], ['FLEX', 1], ['STRICT', 2]])
})
test('a blank input is the contract default (null), never an empty-string set', () => {
  assert.equal(setFromInput(''), null)
  assert.equal(setFromInput('   '), null)
  assert.equal(setFromInput(' STRICT '), 'STRICT')
})
