import { parseMajorToMinor } from './minor-units'

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

/** ADR 0067 F-10: a rule charges a percent, an amount or a number of nights; a NO_SHOW rule applies when the guest does not arrive. */
export interface RuleText { kind?: string | null; daysBeforeCheckin: number; penaltyPercent: number | null; penaltyMinor: string | null; penaltyNights?: number | null; currency: string | null }

/** How a rule reads in Admin. `money` formats minor units in the rule's currency. */
export function describeRule(rule: RuleText, money: (minor: string, currency: string) => string): string {
  const penalty = rule.penaltyNights != null ? `${rule.penaltyNights} night${rule.penaltyNights === 1 ? '' : 's'} penalty`
    : rule.penaltyPercent != null ? `${rule.penaltyPercent}% penalty`
      : rule.penaltyMinor != null && rule.currency ? `${money(rule.penaltyMinor, rule.currency)} penalty` : 'penalty unspecified'
  return rule.kind === 'NO_SHOW' ? `No-show: ${penalty}` : `${rule.daysBeforeCheckin}+ days before check-in: ${penalty}`
}

/** The penalty part of a new rule from the form: a percent or a number of nights. Null when the value is not a whole number. */
export function penaltyFromInput(form: 'PERCENT' | 'NIGHTS' | 'FIXED', value: string, currency?: string): { penaltyPercent: number } | { penaltyNights: number } | { penaltyMinor: string; currency: string } | null {
  if (form === 'FIXED') {
    if (!currency) return null
    const minor = parseMajorToMinor(value, currency)
    return minor === null ? null : { penaltyMinor: minor, currency }
  }
  if (!/^\d{1,3}$/.test(value.trim())) return null
  const n = Number(value)
  if (form === 'NIGHTS' ? n < 1 || n > 30 : n > 100) return null
  return form === 'NIGHTS' ? { penaltyNights: n } : { penaltyPercent: n }
}
