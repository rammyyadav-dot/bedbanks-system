import { isValidPolicySetName, policySetNames, rulesForPlan } from './cancellation-rules'

const rule = (policySet: string | null, daysBeforeCheckin = 7) => ({ policySet, daysBeforeCheckin })
const rules = [rule(null, 3), rule(null, 10), rule('FLEX', 1), rule('STRICT', 30), rule('STRICT', 14)]

describe('cancellation rules for a plan', () => {
  it('a plan with no set uses only the contract default, as before', () => {
    const r = rulesForPlan({ cancellationPolicySet: null }, rules)
    expect(r).toMatchObject({ source: 'contract_default', set: null, missing: false })
    expect(r.rules.map((x) => x.daysBeforeCheckin)).toEqual([3, 10])
  })
  it('a plan with a set uses only that set', () => {
    const r = rulesForPlan({ cancellationPolicySet: 'STRICT' }, rules)
    expect(r).toMatchObject({ source: 'plan_set', set: 'STRICT', missing: false })
    expect(r.rules.map((x) => x.daysBeforeCheckin)).toEqual([30, 14])
  })
  it('a named set with no rules is missing and never falls back to the default', () => {
    const r = rulesForPlan({ cancellationPolicySet: 'GONE' }, rules)
    expect(r.missing).toBe(true)
    expect(r.rules).toEqual([])
  })
  it('set names are case-sensitive: flex is not FLEX', () => {
    expect(rulesForPlan({ cancellationPolicySet: 'flex' }, rules).missing).toBe(true)
  })
  it('lists distinct named sets without the default', () => { expect(policySetNames(rules)).toEqual(['FLEX', 'STRICT']) })
  it('validates names', () => {
    expect(isValidPolicySetName('Flex 7d')).toBe(true)
    for (const bad of ['', ' lead', 'trail ', '-x', 'a'.repeat(81), 'a/b', 5, null]) expect(isValidPolicySetName(bad)).toBe(false)
  })
})
