export type MarkupScopeName = 'TENANT_DEFAULT' | 'SUPPLIER' | 'HOTEL'

/** An ACTIVE rule, with calendar dates as YYYY-MM-DD strings (validTo null is open-ended). */
export interface MarkupRuleRow {
  scope: MarkupScopeName
  supplierId: string | null
  hotelId: string | null
  basisPoints: number
  validFrom: string
  validTo: string | null
}

const SPECIFICITY: Record<MarkupScopeName, number> = { HOTEL: 3, SUPPLIER: 2, TENANT_DEFAULT: 1 }

/**
 * The basis points in force for a hotel, supplier and night: the most specific ACTIVE rule whose dates contain the night
 * (hotel, then supplier, then tenant default). Null means no rule applies, and a NET rate is then not sellable.
 * A rule outside its dates is skipped, so a hotel rule that has ended falls back to the supplier or default rule.
 */
export function resolveMarkupBasisPoints(rules: readonly MarkupRuleRow[], target: { supplierId: string; hotelId: string }, date: string): number | null {
  let best: MarkupRuleRow | null = null
  for (const rule of rules) {
    if (date < rule.validFrom || (rule.validTo !== null && date > rule.validTo)) continue
    if (rule.scope === 'HOTEL' && rule.hotelId !== target.hotelId) continue
    if (rule.scope === 'SUPPLIER' && rule.supplierId !== target.supplierId) continue
    if (!best || SPECIFICITY[rule.scope] > SPECIFICITY[best.scope] || (SPECIFICITY[rule.scope] === SPECIFICITY[best.scope] && rule.validFrom > best.validFrom)) best = rule
  }
  return best ? best.basisPoints : null
}

/** A per-night resolver for one plan, for `buildStaySnapshot`. */
export function markupResolverFor(rules: readonly MarkupRuleRow[], supplierId: string, hotelId: string): (date: string) => number | null {
  return (date) => resolveMarkupBasisPoints(rules, { supplierId, hotelId }, date)
}
