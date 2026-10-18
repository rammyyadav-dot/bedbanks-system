import test from 'node:test'
import assert from 'node:assert/strict'
import { describeRule, groupRules, penaltyFromInput, setFromInput, setNames } from './cancellation-sets'

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

test('rules read with their penalty form and kind (ADR 0067, F-10)', () => {
  const money = (m: string, c: string) => `${c} ${m}`
  assert.equal(describeRule({ daysBeforeCheckin: 3, penaltyPercent: null, penaltyMinor: null, penaltyNights: 1, currency: null }, money), '3+ days before check-in: 1 night penalty')
  assert.equal(describeRule({ kind: 'NO_SHOW', daysBeforeCheckin: 0, penaltyPercent: 100, penaltyMinor: null, currency: null }, money), 'No-show: 100% penalty')
  assert.equal(describeRule({ daysBeforeCheckin: 7, penaltyPercent: null, penaltyMinor: '500', currency: 'AED' }, money), '7+ days before check-in: AED 500 penalty')
  assert.deepEqual(penaltyFromInput('NIGHTS', '2'), { penaltyNights: 2 })
  assert.deepEqual(penaltyFromInput('PERCENT', '50'), { penaltyPercent: 50 })
  assert.equal(penaltyFromInput('PERCENT', '5.5'), null)
})
