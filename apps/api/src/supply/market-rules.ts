/**
 * Contract sales markets and guest nationalities (ADR 0035). Pure: no I/O.
 *
 * A contract may list the buyer markets it is sold to (`salesMarkets`, matched against the buying agency's country) and the guest
 * nationalities it accepts (`nationalities`). An empty list restricts nothing. A non-empty list is an allow-list, and it fails closed:
 * an unknown buyer market or nationality is not allowed, and a malformed list makes the contract unsellable rather than unrestricted.
 */
export const COUNTRY_CODE = /^[A-Z]{2}$/
export const MAX_MARKET_LIST = 250

/** What the buyer is, when the caller is an Agent. Null means "could not be determined", which never satisfies a restriction. */
export interface BuyerContext { nationality: string | null; market: string | null }

/** Normalized ISO-3166 alpha-2 list: unset or null is empty (unrestricted); a non-array, a non-string, a bad code or an oversized list is invalid (null). */
export function parseMarketList(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_MARKET_LIST) return null
  const out = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') return null
    const code = item.trim().toUpperCase()
    if (!COUNTRY_CODE.test(code)) return null
    out.add(code)
  }
  return [...out].sort()
}

export interface ContractMarketRules { salesMarkets: string[] | null; nationalities: string[] | null }
export const parseMarketRules = (contract: { salesMarkets?: unknown; nationalities?: unknown }): ContractMarketRules => ({ salesMarkets: parseMarketList(contract.salesMarkets), nationalities: parseMarketList(contract.nationalities) })

/** Normalizes a code supplied by a caller. Anything that is not two letters is treated as unknown. */
export const normalizeCountry = (value: string | null | undefined): string | null => {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return COUNTRY_CODE.test(code) ? code : null
}

/** Reasons a buyer may not buy under these rules. Empty when the contract is open to them. */
export function marketReasons(rules: ContractMarketRules, buyer: BuyerContext): string[] {
  if (rules.salesMarkets === null || rules.nationalities === null) return ['CONTRACT_MARKET_RULE_INVALID']
  const reasons: string[] = []
  const market = normalizeCountry(buyer.market); const nationality = normalizeCountry(buyer.nationality)
  if (rules.salesMarkets.length > 0 && (market === null || !rules.salesMarkets.includes(market))) reasons.push('SOURCE_MARKET_NOT_ALLOWED')
  if (rules.nationalities.length > 0 && (nationality === null || !rules.nationalities.includes(nationality))) reasons.push('NATIONALITY_NOT_ALLOWED')
  return reasons
}

/**
 * Plan-level rules (ADR 0057, S3). Same allow-list semantics as the contract, with plan-specific codes so a refusal names its source.
 * The buyer must pass BOTH the contract rules and these; a plan can narrow the contract but never widen it.
 */
export function planMarketReasons(rules: ContractMarketRules, buyer: BuyerContext): string[] {
  return marketReasons(rules, buyer).map((reason) => reason === 'SOURCE_MARKET_NOT_ALLOWED' ? 'RATE_PLAN_SOURCE_MARKET_NOT_ALLOWED'
    : reason === 'NATIONALITY_NOT_ALLOWED' ? 'RATE_PLAN_NATIONALITY_NOT_ALLOWED' : reason === 'CONTRACT_MARKET_RULE_INVALID' ? 'RATE_PLAN_MARKET_RULE_INVALID' : reason)
}

/** Codes in a plan list that the contract's non-empty list does not include. An empty contract list allows anything. Null (malformed) lists are reported by the caller. */
export const codesOutsideContract = (plan: readonly string[], contract: readonly string[]): string[] => contract.length === 0 ? [] : plan.filter((code) => !contract.includes(code))
