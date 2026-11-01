import type { MarketInclusionType, MarketMatchType, MarketValidityRuleRead, MarketValidityRuleWrite, SourceMarketGroupRead } from '@bedbanks/contracts'
import { badCodes, parseCodeList } from './market-list'

export interface CountryOption {
  code: string
  name: string
  region: string
}

export const ISO_COUNTRY_OPTIONS: readonly CountryOption[] = [
  { code: 'AE', name: 'United Arab Emirates', region: 'GCC' },
  { code: 'SA', name: 'Saudi Arabia', region: 'GCC' },
  { code: 'QA', name: 'Qatar', region: 'GCC' },
  { code: 'OM', name: 'Oman', region: 'GCC' },
  { code: 'BH', name: 'Bahrain', region: 'GCC' },
  { code: 'KW', name: 'Kuwait', region: 'GCC' },
  { code: 'IN', name: 'India', region: 'South Asia' },
  { code: 'GB', name: 'United Kingdom', region: 'Europe' },
  { code: 'IE', name: 'Ireland', region: 'Europe' },
  { code: 'DE', name: 'Germany', region: 'EU Schengen' },
  { code: 'FR', name: 'France', region: 'EU Schengen' },
  { code: 'IT', name: 'Italy', region: 'EU Schengen' },
  { code: 'ES', name: 'Spain', region: 'EU Schengen' },
  { code: 'NL', name: 'Netherlands', region: 'EU Schengen' },
  { code: 'CH', name: 'Switzerland', region: 'EU Schengen' },
  { code: 'RU', name: 'Russia', region: 'CIS' },
  { code: 'KZ', name: 'Kazakhstan', region: 'CIS' },
  { code: 'UZ', name: 'Uzbekistan', region: 'CIS' },
  { code: 'AZ', name: 'Azerbaijan', region: 'CIS' },
  { code: 'SG', name: 'Singapore', region: 'Southeast Asia' },
  { code: 'MY', name: 'Malaysia', region: 'Southeast Asia' },
  { code: 'TH', name: 'Thailand', region: 'Southeast Asia' },
  { code: 'ID', name: 'Indonesia', region: 'Southeast Asia' },
  { code: 'US', name: 'United States', region: 'Americas' },
  { code: 'CA', name: 'Canada', region: 'Americas' },
  { code: 'AU', name: 'Australia', region: 'Oceania' },
  { code: 'CN', name: 'China', region: 'East Asia' },
  { code: 'JP', name: 'Japan', region: 'East Asia' },
]

export interface MarketGroupPreset {
  code: string
  name: string
  countryCodes: string[]
}

export const SOURCE_MARKET_GROUP_PRESETS: readonly MarketGroupPreset[] = [
  { code: 'GCC', name: 'Gulf Cooperation Council', countryCodes: ['AE', 'SA', 'QA', 'OM', 'BH', 'KW'] },
  { code: 'DOMESTIC_IN', name: 'Domestic India', countryCodes: ['IN'] },
  { code: 'CIS', name: 'Commonwealth of Independent States', countryCodes: ['RU', 'KZ', 'UZ', 'AZ'] },
  { code: 'EU_SCHENGEN', name: 'European Schengen Cluster', countryCodes: ['DE', 'FR', 'IT', 'ES', 'NL', 'CH'] },
  { code: 'SEA_CLUSTER', name: 'Southeast Asia Cluster', countryCodes: ['SG', 'MY', 'TH', 'ID'] },
]

export function toggleCountrySelection(current: readonly string[], code: string): string[] {
  const normalized = code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(normalized)) return [...current]
  const set = new Set(current.map((c) => c.toUpperCase()))
  if (set.has(normalized)) set.delete(normalized)
  else set.add(normalized)
  return [...set].sort()
}

export function mergeSelectedAndCustomCountries(selected: readonly string[], customInput: string): { codes: string[]; invalid: string[] } {
  const custom = parseCodeList(customInput)
  const invalid = badCodes(custom)
  const combined = new Set<string>([...selected.map((c) => c.toUpperCase()), ...custom.filter((c) => /^[A-Z]{2}$/.test(c))])
  return { codes: [...combined].sort(), invalid }
}

export function describeMarketValidityRule(
  rule: MarketValidityRuleRead,
  ratePlanCodeById: (ratePlanId: string) => string,
  groupById?: (groupId: string) => SourceMarketGroupRead | undefined
): { scopeLabel: string; actionLabel: string; targetLabel: string } {
  const scopeLabel = rule.ratePlanId ? `Rate Plan: ${ratePlanCodeById(rule.ratePlanId)}` : 'Entire Contract (Default)'
  const actionLabel = rule.inclusionType === 'EXCLUDE' ? 'EXCLUDE (Fail-safe block)' : 'INCLUDE (Allow)'
  let targetLabel = 'All source markets (Worldwide)'
  if (rule.matchType === 'COUNTRY_CODE') {
    targetLabel = rule.countryCodes.length > 0 ? `Countries: ${rule.countryCodes.join(', ')}` : 'No countries'
  } else if (rule.matchType === 'MARKET_GROUP') {
    const group = rule.marketGroup ?? (rule.marketGroupId && groupById ? groupById(rule.marketGroupId) : undefined)
    targetLabel = group
      ? `Group ${group.code} (${group.name}: ${group.countryCodes.join(', ')}${group.isActive ? '' : ' · INACTIVE'})`
      : `Group ID: ${rule.marketGroupId ?? 'Unbound'}`
  }
  return { scopeLabel, actionLabel, targetLabel }
}

export function describeEvaluationReason(reason: string): string {
  switch (reason) {
    case 'worldwide_default':
      return 'Open worldwide (no restriction configured)'
    case 'valid_source_market_match':
      return 'Valid source market match (INCLUDE rule satisfied)'
    case 'explicitly_excluded_by_source_market':
      return 'Explicitly excluded by source market (EXCLUDE rule matched)'
    case 'source_market_not_matched':
      return 'Source market did not match any INCLUDE rule'
    case 'rate_plan_not_found':
      return 'Rate plan not found in active tenant'
    default:
      return reason
  }
}

export interface RuleFormDraft {
  ratePlanId: string
  inclusionType: MarketInclusionType
  matchType: MarketMatchType
  selectedCountries: string[]
  customCountries: string
  marketGroupId: string
}

export const blankRuleDraft: RuleFormDraft = {
  ratePlanId: '',
  inclusionType: 'INCLUDE',
  matchType: 'MARKET_GROUP',
  selectedCountries: [],
  customCountries: '',
  marketGroupId: '',
}

export function buildMarketValidityRuleWrite(draft: RuleFormDraft): MarketValidityRuleWrite | string {
  const ratePlanId = draft.ratePlanId.trim() || null
  if (draft.matchType === 'COUNTRY_CODE') {
    const { codes, invalid } = mergeSelectedAndCustomCountries(draft.selectedCountries, draft.customCountries)
    if (invalid.length > 0) return `Invalid two-letter ISO country code(s): ${invalid.join(', ')}.`
    if (codes.length === 0) return 'Select or enter at least one two-letter ISO country code.'
    return {
      ratePlanId,
      inclusionType: draft.inclusionType,
      matchType: 'COUNTRY_CODE',
      countryCodes: codes,
      marketGroupId: null,
    }
  }
  if (draft.matchType === 'MARKET_GROUP') {
    if (!draft.marketGroupId.trim()) return 'Select a source market group.'
    return {
      ratePlanId,
      inclusionType: draft.inclusionType,
      matchType: 'MARKET_GROUP',
      countryCodes: [],
      marketGroupId: draft.marketGroupId.trim(),
    }
  }
  return {
    ratePlanId,
    inclusionType: draft.inclusionType,
    matchType: 'WORLDWIDE',
    countryCodes: [],
    marketGroupId: null,
  }
}
