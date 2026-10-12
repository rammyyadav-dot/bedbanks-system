/**
 * Which cancellation rules apply to a rate plan (ADR 0057). Pure: no I/O.
 *
 * A contract holds rules, each in a named set or in the contract default (set = null). A plan with no `cancellationPolicySet` uses the
 * contract default, exactly as before. A plan that names a set uses only that set. A named set with no rules is `missing`, never
 * silently replaced by the default: the caller must treat it as not sellable / needing review.
 */
export const POLICY_SET_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/

export interface RuleLike { policySet: string | null }
export interface ResolvedRules<T extends RuleLike> { source: 'plan_set' | 'contract_default'; set: string | null; rules: T[]; missing: boolean }

export function isValidPolicySetName(value: unknown): value is string { return typeof value === 'string' && POLICY_SET_NAME.test(value) && value === value.trim() }

export function rulesForPlan<T extends RuleLike>(plan: { cancellationPolicySet: string | null }, contractRules: readonly T[]): ResolvedRules<T> {
  if (plan.cancellationPolicySet === null) return { source: 'contract_default', set: null, rules: contractRules.filter((rule) => rule.policySet === null), missing: false }
  const rules = contractRules.filter((rule) => rule.policySet === plan.cancellationPolicySet)
  return { source: 'plan_set', set: plan.cancellationPolicySet, rules, missing: rules.length === 0 }
}

/** Distinct named sets on a contract, sorted. The contract default is not a name. */
export const policySetNames = (contractRules: readonly RuleLike[]): string[] => [...new Set(contractRules.map((rule) => rule.policySet).filter((name): name is string => name !== null))].sort()
