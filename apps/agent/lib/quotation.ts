import { applyPercentMarkup } from '@bedbanks/pricing'
import type { Money } from '@bedbanks/money'
import {
  QUOTATION_LINE_ITEM_MAX,
  QUOTATION_MARKUP_MAX_BP,
  validateAgencyBranding,
  validateQuotationLineItems,
  type AgencyBrandingInput,
  type QuotationIssue,
  type QuotationLineItemInput,
} from '@bedbanks/contracts/agent'

export { QUOTATION_LINE_ITEM_MAX, QUOTATION_MARKUP_MAX_BP }

/**
 * Preview-only client price for display while the agent edits the draft. The authoritative figure that gets
 * persisted and exported is always recomputed server-side from sellMinor and markupBasisPoints (CLAUDE.md
 * invariant 3): this must never be sent as the price, only shown beside the inputs that produce it.
 */
export function previewClientPriceMinor(sellMinor: string, markupBasisPoints: number, currency: string): Money | null {
  if (!/^\d{1,15}$/.test(sellMinor)) return null
  if (!Number.isSafeInteger(markupBasisPoints) || markupBasisPoints < 0 || markupBasisPoints > QUOTATION_MARKUP_MAX_BP) return null
  try { return applyPercentMarkup({ amountMinor: Number(sellMinor), currency }, markupBasisPoints) } catch { return null }
}

/** Sum of a set of preview client prices, all in the same currency, for the draft total shown above the export actions. */
export function previewTotalMinor(lineItems: QuotationLineItemInput[], currency: string): Money | null {
  let total = 0n
  for (const item of lineItems) {
    const price = previewClientPriceMinor(item.sellMinor, item.markupBasisPoints, currency)
    if (price === null) return null
    total += BigInt(price.amountMinor)
  }
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? { amountMinor: Number(total), currency } : null
}

export type QuotationFormIssues = { lineItems?: QuotationIssue[]; branding?: QuotationIssue[] }

/** Structural validation before a create/update call: the server still re-verifies every sourceOfferId's price. */
export function validateQuotationDraft(lineItems: QuotationLineItemInput[], branding: AgencyBrandingInput): QuotationFormIssues | null {
  const issues: QuotationFormIssues = {}
  const lineResult = validateQuotationLineItems(lineItems)
  if (!lineResult.ok) issues.lineItems = lineResult.issues
  const brandingIssues = validateAgencyBranding(branding)
  if (brandingIssues.length > 0) issues.branding = brandingIssues
  return issues.lineItems || issues.branding ? issues : null
}

export function emptyBranding(): AgencyBrandingInput {
  return { legalName: '', address: '', contactEmail: '', contactPhone: '', logoAssetId: null }
}
