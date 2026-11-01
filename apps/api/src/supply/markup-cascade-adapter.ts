import { applyMarkupCascade, type CascadeResult, type MarkupLayer } from '@bedbanks/pricing'
import { resolveMarkupBasisPoints, type MarkupBuyer, type MarkupRuleRow } from './markup-rules'

/**
 * ADR 0080 phase 1: today's single-winner rule resolution expressed as a one-layer cascade. It is not called by the evaluator yet; it exists so
 * the equivalence is tested before phase 2 adds more layers. A client or market tier maps to the CLIENT layer, everything else to SUPPLIER_CONTRACT.
 * Returns null when no rule applies (a NET rate is then not sellable), exactly like `resolveMarkupBasisPoints`.
 */
export function legacyCascadeLayers(rules: readonly MarkupRuleRow[], target: { supplierId: string; hotelId: string }, date: string, buyer?: MarkupBuyer): MarkupLayer[] | null {
  const basisPoints = resolveMarkupBasisPoints(rules, target, date, buyer)
  if (basisPoints === null) return null
  const tiered = rules.some((r) => (r.agencyId || r.market) && r.basisPoints === basisPoints && resolveMarkupBasisPoints([r], target, date, buyer) !== null)
  return [{ layer: tiered ? 'CLIENT' : 'SUPPLIER_CONTRACT', ruleId: 'legacy', adjustment: { kind: 'PERCENT', basisPoints } }]
}

/** Prices a NET amount through the legacy rules using the cascade engine. Null when no rule applies. */
export function priceViaCascade(netMinor: bigint, rules: readonly MarkupRuleRow[], target: { supplierId: string; hotelId: string }, date: string, buyer?: MarkupBuyer): CascadeResult | null {
  const layers = legacyCascadeLayers(rules, target, date, buyer)
  return layers ? applyMarkupCascade(netMinor, layers) : null
}
