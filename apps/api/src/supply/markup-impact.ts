import { MAX_MARKUP_BASIS_POINTS, markupMinor } from '@bedbanks/pricing'

/**
 * How one ACTIVE plan-night counts in the markup impact view. A missing night, a non-positive amount (ADR 0034) or a currency
 * that is not the plan's is a rate gap and is not counted. A NET night whose rule is missing or cannot be applied (outside 0..100%)
 * is unpriced, which is the same as unsellable. Zero basis points is a real rule: the night is priced with no markup.
 */
export interface MarkupNightRate { amountMinor: bigint; currency: string; amountBasis: string | null }

export type MarkupNightClass =
  | { class: 'gap' }
  | { class: 'sell' }
  | { class: 'basis_unverified' }
  | { class: 'net_unpriced' }
  | { class: 'net_priced'; markupMinor: bigint }

export function classifyMarkupNight(rate: MarkupNightRate | undefined, planCurrency: string, basisPoints: number | null): MarkupNightClass {
  if (!rate || rate.amountMinor <= 0n || rate.currency !== planCurrency) return { class: 'gap' }
  if (rate.amountBasis === 'SELL') return { class: 'sell' }
  if (rate.amountBasis !== 'NET') return { class: 'basis_unverified' }
  if (basisPoints === null || !Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > MAX_MARKUP_BASIS_POINTS) return { class: 'net_unpriced' }
  return { class: 'net_priced', markupMinor: markupMinor(rate.amountMinor, basisPoints) }
}
