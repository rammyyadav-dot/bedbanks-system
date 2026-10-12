/** Cancellation rule sets on a contract (ADR 0057). Blank set name = the contract default. The API owns validation. */
export interface SetRule { policySet?: string | null }

export const DEFAULT_SET_LABEL = 'Contract default'

/** Distinct named sets, sorted; the contract default is not a name. */
export const setNames = (rules: readonly SetRule[]): string[] => [...new Set(rules.map((rule) => rule.policySet ?? null).filter((name): name is string => name !== null))].sort()

/** Rules grouped for display: the default first, then each named set. */
export function groupRules<T extends SetRule>(rules: readonly T[]): Array<{ set: string | null; label: string; rules: T[] }> {
  const groups: Array<{ set: string | null; label: string; rules: T[] }> = []
  const defaults = rules.filter((rule) => (rule.policySet ?? null) === null)
  if (defaults.length) groups.push({ set: null, label: DEFAULT_SET_LABEL, rules: defaults })
  for (const name of setNames(rules)) groups.push({ set: name, label: `Set "${name}"`, rules: rules.filter((rule) => rule.policySet === name) })
  return groups
}

/** The form sends null for blank so the API sees "contract default", not an empty name. */
export const setFromInput = (value: string): string | null => (value.trim() === '' ? null : value.trim())
