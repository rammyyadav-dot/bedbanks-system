/**
 * Agent quotation builder (ADR 0092): a white-label proposal an agent assembles from live search/offer results and
 * exports as PDF or Excel for their own client. Pure and transport-agnostic: no Nest, no Prisma, no clock.
 *
 * Money stays in integer minor units end to end (CLAUDE.md invariant 3): a line item carries the sell price the
 * search/offer already quoted plus an agent-entered markup, both minor-unit strings in the quotation's currency.
 * The server recomputes and is the only source of the figures that end up on an exported document; a client-side
 * total is preview arithmetic only and is never trusted as the figure that gets exported or billed.
 *
 * tenantId is never accepted from the client: every mutation below is scoped by the caller's authenticated
 * context, matching every other agent contract in this package.
 */
import type { MinorString } from './operations'

export const QUOTATION_EXPORT_FORMATS = ['pdf', 'xlsx'] as const
export type QuotationExportFormat = (typeof QUOTATION_EXPORT_FORMATS)[number]

export const QUOTATION_EXPORT_STATUSES = ['QUEUED', 'READY', 'FAILED'] as const
export type QuotationExportStatus = (typeof QUOTATION_EXPORT_STATUSES)[number]

export const QUOTATION_LINE_ITEM_MAX = 20
export const QUOTATION_MARKUP_MAX_BP = 5_000
export const QUOTATION_NOTE_MAX = 500
export const AGENCY_LEGAL_NAME_MAX = 120
export const AGENCY_ADDRESS_MAX = 240
export const AGENCY_CONTACT_MAX = 120

/** One hotel/room/stay combination carried over from a search or offer result, never re-priced on the client. */
export interface QuotationLineItemInput {
  /** The offer or rate-plan result this line was built from; lets the server re-verify the price it is quoting. */
  sourceOfferId: string
  hotelId: string
  hotelName: string
  roomTypeId: string
  roomTypeName: string
  checkIn: string
  checkOut: string
  nights: number
  occupancy: { adults: number; childAges: number[] }
  /** The authoritative sell total for this line, as already quoted by search/offer. Minor units, quotation currency. */
  sellMinor: MinorString
  /** Agent-entered markup for their own client, basis points (1% = 100bp), applied by the server on top of sellMinor. */
  markupBasisPoints: number
  note?: string
}

export interface QuotationLineItem extends QuotationLineItemInput {
  id: string
  /** sellMinor plus the markup, computed server-side. Never accepted from the client. */
  clientPriceMinor: MinorString
}

export interface AgencyBrandingInput {
  legalName: string
  address: string
  contactEmail: string
  contactPhone: string
  /** An uploaded asset id, never a raw file or data URL in the contract. */
  logoAssetId?: string | null
}

export interface CreateQuotationRequest {
  currency: string
  branding: AgencyBrandingInput
  lineItems: QuotationLineItemInput[]
  idempotencyKey: string
}

export interface UpdateQuotationRequest {
  branding?: AgencyBrandingInput
  lineItems?: QuotationLineItemInput[]
  expectedUpdatedAt: string
  idempotencyKey: string
}

export interface Quotation {
  id: string
  currency: string
  branding: AgencyBrandingInput
  lineItems: QuotationLineItem[]
  /** Sum of clientPriceMinor across lineItems, server-computed. */
  totalMinor: MinorString
  createdAt: string
  updatedAt: string
}

export interface QuotationExportRequest {
  quotationId: string
  format: QuotationExportFormat
  idempotencyKey: string
}

export interface QuotationExportJob {
  id: string
  quotationId: string
  format: QuotationExportFormat
  status: QuotationExportStatus
  /** Present only once status is READY; a time-limited signed URL, never a public asset path. */
  downloadUrl?: string
  failureReason?: string
  createdAt: string
}

export const QUOTATION_FAILURE = {
  invalid: 'QUOTATION_INVALID',
  empty: 'QUOTATION_EMPTY',
  tooManyLineItems: 'QUOTATION_TOO_MANY_LINE_ITEMS',
  markupTooHigh: 'QUOTATION_MARKUP_TOO_HIGH',
  stale: 'QUOTATION_STALE',
  offerUnverifiable: 'QUOTATION_OFFER_UNVERIFIABLE',
} as const

export interface QuotationIssue { field: string; message: string }
export type QuotationValidation =
  | { ok: true; lineItems: QuotationLineItemInput[] }
  | { ok: false; issues: QuotationIssue[] }

const MINOR = /^\d{1,15}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function validLineItem(value: unknown, index: number, issues: QuotationIssue[]): void {
  const prefix = `lineItems[${index}]`
  if (typeof value !== 'object' || value === null) { issues.push({ field: prefix, message: 'Each line item must be an object' }); return }
  const item = value as Partial<QuotationLineItemInput>
  if (typeof item.sourceOfferId !== 'string' || item.sourceOfferId.length === 0) issues.push({ field: `${prefix}.sourceOfferId`, message: 'A source offer is required' })
  if (typeof item.sellMinor !== 'string' || !MINOR.test(item.sellMinor)) issues.push({ field: `${prefix}.sellMinor`, message: 'sellMinor must be an integer minor-unit string' })
  if (typeof item.markupBasisPoints !== 'number' || !Number.isSafeInteger(item.markupBasisPoints) || item.markupBasisPoints < 0) {
    issues.push({ field: `${prefix}.markupBasisPoints`, message: 'markupBasisPoints must be a non-negative integer' })
  } else if (item.markupBasisPoints > QUOTATION_MARKUP_MAX_BP) {
    issues.push({ field: `${prefix}.markupBasisPoints`, message: `The markup can be at most ${QUOTATION_MARKUP_MAX_BP / 100}%` })
  }
  if (typeof item.note === 'string' && item.note.length > QUOTATION_NOTE_MAX) issues.push({ field: `${prefix}.note`, message: `A line note can be at most ${QUOTATION_NOTE_MAX} characters` })
}

/** Structural validation only: field shapes, counts and markup bounds. The server still re-verifies each sourceOfferId's price before persisting. */
export function validateQuotationLineItems(lineItems: unknown): QuotationValidation {
  const issues: QuotationIssue[] = []
  if (!Array.isArray(lineItems) || lineItems.length === 0) return { ok: false, issues: [{ field: 'lineItems', message: 'At least one line item is required' }] }
  if (lineItems.length > QUOTATION_LINE_ITEM_MAX) return { ok: false, issues: [{ field: 'lineItems', message: `At most ${QUOTATION_LINE_ITEM_MAX} line items are allowed` }] }
  lineItems.forEach((item, index) => validLineItem(item, index, issues))
  return issues.length > 0 ? { ok: false, issues } : { ok: true, lineItems: lineItems as QuotationLineItemInput[] }
}

export function validateAgencyBranding(branding: unknown): QuotationIssue[] {
  const issues: QuotationIssue[] = []
  if (typeof branding !== 'object' || branding === null) return [{ field: 'branding', message: 'Branding is required' }]
  const b = branding as Partial<AgencyBrandingInput>
  if (typeof b.legalName !== 'string' || b.legalName.trim().length === 0) issues.push({ field: 'branding.legalName', message: 'Agency legal name is required' })
  else if (b.legalName.length > AGENCY_LEGAL_NAME_MAX) issues.push({ field: 'branding.legalName', message: `Legal name can be at most ${AGENCY_LEGAL_NAME_MAX} characters` })
  if (typeof b.address !== 'string' || b.address.trim().length === 0) issues.push({ field: 'branding.address', message: 'Agency address is required' })
  else if (b.address.length > AGENCY_ADDRESS_MAX) issues.push({ field: 'branding.address', message: `Address can be at most ${AGENCY_ADDRESS_MAX} characters` })
  if (typeof b.contactEmail !== 'string' || !EMAIL.test(b.contactEmail)) issues.push({ field: 'branding.contactEmail', message: 'A valid contact email is required' })
  if (typeof b.contactPhone !== 'string' || b.contactPhone.trim().length === 0) issues.push({ field: 'branding.contactPhone', message: 'A contact phone is required' })
  else if (b.contactPhone.length > AGENCY_CONTACT_MAX) issues.push({ field: 'branding.contactPhone', message: `Contact phone can be at most ${AGENCY_CONTACT_MAX} characters` })
  return issues
}
