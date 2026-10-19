export type MarkupScopeName = 'TENANT_DEFAULT' | 'SUPPLIER' | 'HOTEL'

/** An ACTIVE rule, with calendar dates as YYYY-MM-DD strings (validTo null is open-ended). */
export interface MarkupRuleRow {
  scope: MarkupScopeName
  supplierId: string | null
  hotelId: string | null
  basisPoints: number
  validFrom: string
  validTo: string | null
  /** ADR 0067 F-11: client tier (one agency) and market tier (buyer country). Absent or null: the rule is generic. */
  agencyId?: string | null
  market?: string | null
  /** Hotels and suppliers the rule does not apply to; the next rule in precedence applies there. Absent: none. */
  excludedHotelIds?: readonly string[]
  excludedSupplierIds?: readonly string[]
}

/** Who is buying, for client and market tiers. Null fields match only generic rules. */
export interface MarkupBuyer { agencyId: string | null; market: string | null }

const SPECIFICITY: Record<MarkupScopeName, number> = { HOTEL: 3, SUPPLIER: 2, TENANT_DEFAULT: 1 }
/** A client tier outranks a market tier, which outranks a generic rule; within each, hotel outranks supplier outranks tenant default. */
const rank = (rule: MarkupRuleRow): number => (rule.agencyId ? 100 : 0) + (rule.market ? 10 : 0) + SPECIFICITY[rule.scope]

/**
 * The basis points in force for a hotel, supplier, night and buyer: the highest-ranked ACTIVE rule whose dates contain the night, whose target
 * matches, whose client and market tiers match the buyer (a tier the buyer does not have never applies) and whose exclusions do not name this
 * hotel or supplier. Ties go to the later validFrom. Null means no rule applies, and a NET rate is then not sellable.
 * A rule outside its dates is skipped, so a hotel rule that has ended falls back to the supplier or default rule.
 */
export function resolveMarkupBasisPoints(rules: readonly MarkupRuleRow[], target: { supplierId: string; hotelId: string }, date: string, buyer: MarkupBuyer = { agencyId: null, market: null }): number | null {
  let best: MarkupRuleRow | null = null
  for (const rule of rules) {
    if (date < rule.validFrom || (rule.validTo !== null && date > rule.validTo)) continue
    if (rule.scope === 'HOTEL' && rule.hotelId !== target.hotelId) continue
    if (rule.scope === 'SUPPLIER' && rule.supplierId !== target.supplierId) continue
    if (rule.agencyId && rule.agencyId !== buyer.agencyId) continue
    if (rule.market && rule.market !== buyer.market) continue
    if (rule.excludedHotelIds?.includes(target.hotelId) || rule.excludedSupplierIds?.includes(target.supplierId)) continue
    if (!best || rank(rule) > rank(best) || (rank(rule) === rank(best) && rule.validFrom > best.validFrom)) best = rule
  }
  return best ? best.basisPoints : null
}

/** A per-night resolver for one plan and buyer, for `buildStaySnapshot`. Without a buyer only generic rules apply. */
export function markupResolverFor(rules: readonly MarkupRuleRow[], supplierId: string, hotelId: string, buyer?: MarkupBuyer): (date: string) => number | null {
  return (date) => resolveMarkupBasisPoints(rules, { supplierId, hotelId }, date, buyer)
}

/** True when any rule depends on who buys, so the buyer's agency must be read before pricing. */
export const rulesNeedBuyer = (rules: readonly MarkupRuleRow[]): boolean => rules.some((rule) => !!rule.agencyId || !!rule.market)
