/**
 * The backlog of the booking Finance consumer (ADR 0076): what it has posted, skipped, and what waits for a person. Read-only; nothing here posts or changes anything.
 * Amounts are integer minor units serialised as strings. The reason codes are the stable codes stored on `BookingFinancePosting.reason`, never free text.
 */
export const POSTING_SKIP_REASONS = [
  'PAY_AT_HOTEL', 'ZERO_SELL', 'ALREADY_CHARGED_ON_LEDGER', 'HOLD_ALREADY_POSTED', 'NO_HOLD_ON_LEDGER', 'HOLD_ALREADY_RELEASED',
  'PENALTY_UNDETERMINED', 'AWAITS_CANCELLATION', 'NOT_CHARGED_ON_LEDGER', 'NOTHING_TO_ADD', 'AMENDMENT_ALREADY_REFLECTED',
] as const
export type PostingSkipReason = (typeof POSTING_SKIP_REASONS)[number]

export const POSTING_REVIEW_REASONS = [
  'PAYMENT_MODE_UNKNOWN', 'NO_AGENCY', 'NO_WALLET', 'NO_SUPPLIER', 'NET_UNKNOWN', 'REFUND_EXCEEDS_CHARGE', 'REFUND_WOULD_DECREASE', 'EVENT_INCONSISTENT',
  'HOLD_AMOUNT_DIFFERS', 'AMENDMENT_NEEDS_LEDGER_ADJUSTMENT',
] as const
export type PostingReviewReason = (typeof POSTING_REVIEW_REASONS)[number]

/** 503 code when the consumer's database role is not configured or lacks a grant. Not an empty backlog. */
export const BOOKING_FINANCE_POSTING_UNAVAILABLE = 'BOOKING_FINANCE_POSTING_UNAVAILABLE'
/** At most this many rows of each list are returned; the counts are always complete. */
export const POSTING_BACKLOG_LIST_LIMIT = 100

export interface PostingBacklogItem {
  eventId: string
  bookingId: string
  eventType: string
  currency: string
  sellMinor: string
  /** When the money fact was recorded. */
  recordedAt: string
}

export interface PostingReviewItem extends PostingBacklogItem {
  reason: string
  attempts: number
  /** The last attempt; the next one is five minutes after it. */
  lastAttemptAt: string
}

export interface PostingBacklogView {
  generatedAt: string
  counts: { posted: number; skipped: number; reviewRequired: number; waiting: number }
  skippedByReason: Array<{ reason: string; count: number }>
  /** Events that need a person, oldest first. */
  review: PostingReviewItem[]
  /** Events not yet attempted (queued, or waiting behind an earlier event of their booking). */
  waiting: PostingBacklogItem[]
  listLimit: number
}

/**
 * Revenue report of the bookings the Finance consumer posted (ADR 0076). Basis: the date the consumer POSTED the event, not the booking, stay or payment date.
 * Scope: Admin-originated bookings only (the Agent flow's charges are not part of it, and neither is their supplier cost). Each currency is its own block; amounts are never converted or added.
 * Margin is indicative: a cancelled booking with a penalty keeps its supplier payable until the supplier's own fee is known (ADR 0070).
 */
export const REVENUE_REPORT_MAX_DAYS = 366
export const REVENUE_REPORT_INVALID_RANGE = 'REVENUE_REPORT_INVALID_RANGE'

export interface RevenueAgencyRow { agencyId: string | null; name: string | null; salesMinor: string; refundsMinor: string; netRevenueMinor: string }
export interface RevenueSupplierRow { supplierId: string; name: string | null; costMinor: string }
export interface RevenueCurrencyBlock {
  currency: string
  /** Charged to agencies (the DEBIT legs). */
  salesMinor: string
  /** Refunded to agencies. */
  refundsMinor: string
  netRevenueMinor: string
  /** Net of accruals, adjustments and reversals owed to suppliers. */
  supplierCostMinor: string
  /** Net revenue less supplier cost. Indicative. */
  marginMinor: string
  /** Posted events that charged an agency. */
  chargedEvents: number
  byAgency: RevenueAgencyRow[]
  bySupplier: RevenueSupplierRow[]
}
export interface RevenueReportView {
  /** Inclusive UTC dates, YYYY-MM-DD. */
  from: string
  to: string
  basis: 'POSTING_DATE'
  generatedAt: string
  currencies: RevenueCurrencyBlock[]
  notes: string[]
  listLimit: number
}

/**
 * Payables posted by the Finance consumer (ADR 0076): what the operator owes each supplier according to the append-only payable entries, per currency.
 * It is the ledger-side counterpart of the booking-net accrual (`SupplierPayablesView`, ADR 0054), which reads the bookings themselves and works whether or not the consumer runs.
 * Neither is an amount to pay: no supplier invoice, payment or settlement record exists. Currencies are never converted or added.
 */
export interface PostedPayableRow {
  supplierId: string
  name: string | null
  currency: string
  /** Accruals on confirmation. */
  accrualsMinor: string
  /** Net of price adjustments (signed). */
  adjustmentsMinor: string
  /** Reversals on penalty-free cancellation (zero or negative). */
  reversalsMinor: string
  /** Accruals + adjustments + reversals. */
  balanceMinor: string
  entries: number
}
export interface PostedPayablesView { generatedAt: string; rows: PostedPayableRow[]; listLimit: number; truncated: boolean }

/**
 * Aging of the posted supplier payables (ADR 0076). Each booking's open balance (the sum of its payable entries, when positive) is aged from the day of its FIRST accrual:
 * there are no payment terms, due dates or supplier payments in the system, so this is the age of what is owed, not how late it is. Per supplier and currency; never added across currencies.
 */
export const PAYABLE_AGING_BUCKETS = [
  { key: 'D0_30', label: '0–30 days', fromDays: 0, toDays: 30 },
  { key: 'D31_60', label: '31–60 days', fromDays: 31, toDays: 60 },
  { key: 'D61_90', label: '61–90 days', fromDays: 61, toDays: 90 },
  { key: 'D91_PLUS', label: 'Over 90 days', fromDays: 91, toDays: null },
] as const
export type PayableAgingBucketKey = (typeof PAYABLE_AGING_BUCKETS)[number]['key']

export interface PayableAgingCell { bucket: PayableAgingBucketKey; amountMinor: string; bookings: number }
export interface PayableAgingRow { supplierId: string; name: string | null; currency: string; buckets: PayableAgingCell[]; totalMinor: string; bookings: number }
export interface PayablesAgingView { asOf: string; rows: PayableAgingRow[]; listLimit: number; truncated: boolean }
