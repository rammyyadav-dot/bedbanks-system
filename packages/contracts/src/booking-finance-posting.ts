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
  /** Supplier payments recorded and approved against this supplier and currency (ADR 0077). */
  paidMinor: string
  /** Balance less payments. Negative means the supplier has been paid more than is posted (a credit with the supplier). */
  outstandingMinor: string
  entries: number
}
export interface PostedPayablesView { generatedAt: string; rows: PostedPayableRow[]; listLimit: number; truncated: boolean }

/**
 * Aging of the posted supplier payables (ADR 0076). Each booking's open balance (the sum of its payable entries, when positive) is aged from the day of its FIRST accrual, and approved supplier payments (ADR 0077) are applied to the oldest bookings first:
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

/**
 * Supplier settlements (ADR 0077): a payment to a supplier, recorded against its posted payables. The system records that a payment was made outside it; it moves no money.
 * PROPOSED by one person (`finance.settle.propose`), APPROVED or REJECTED by another (`finance.settle.approve`; an approval by the proposer is refused). Integer minor units
 * in the payable's currency, never converted.
 */
export const SETTLEMENT_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number]
export const settlementPermissions = { propose: 'finance.settle.propose', approve: 'finance.settle.approve' } as const

export const SETTLEMENT_FAILURE = {
  invalid: 'SETTLEMENT_INVALID', exceedsOwed: 'SETTLEMENT_EXCEEDS_OWED', selfApproval: 'SETTLEMENT_SELF_APPROVAL', notFound: 'SETTLEMENT_NOT_FOUND',
  alreadyDecided: 'SETTLEMENT_ALREADY_DECIDED', disabled: 'SETTLEMENT_DISABLED', idempotencyConflict: 'SETTLEMENT_IDEMPOTENCY_CONFLICT', duplicateReference: 'SETTLEMENT_DUPLICATE_REFERENCE', unknownSupplier: 'SETTLEMENT_UNKNOWN_SUPPLIER',
} as const

/** Writes answer 503 with `SETTLEMENT_FAILURE.disabled` unless the deployment sets SUPPLIER_SETTLEMENT_ENABLED=true. Reads always work. */
export interface SettlementProposeRequest {
  supplierId: string
  currency: string
  /** Digits only, positive, integer minor units. */
  amountMinor: string
  /** The day the payment was made, YYYY-MM-DD (UTC), not in the future. */
  paidOn: string
  /** The bank or transfer reference (3 to 80 characters). The same reference cannot be recorded twice for a supplier. */
  paymentReference: string
  note?: string
  /** Idempotency key (8 to 80 characters): repeating a request with the same key and content returns the same settlement. */
  requestId: string
}
export interface SettlementDecisionRequest { reason?: string }

export interface SettlementView {
  id: string
  supplierId: string
  supplierName: string | null
  currency: string
  amountMinor: string
  paidOn: string
  paymentReference: string
  note: string | null
  status: SettlementStatus
  proposedById: string
  proposedAt: string
  decidedById: string | null
  decidedAt: string | null
  decisionReason: string | null
}
export interface SettlementListView { items: SettlementView[]; listLimit: number; truncated: boolean }

/**
 * Supplier payment terms and due dates (ADR 0078). The usual bedbank arrangement: a supplier is paid a number of days after the guest's check-out (or check-in, or the booking's
 * confirmation for prepaid arrangements). Terms are append-only history; the latest is current. A supplier with no terms, or a booking with no date for the basis, has no due date:
 * it is shown as such and never as overdue. Payments (ADR 0077) are applied to the earliest-due bookings first.
 */
export const SUPPLIER_TERMS_BASES = ['CHECK_OUT', 'CHECK_IN', 'CONFIRMATION'] as const
export type SupplierTermsBasis = (typeof SUPPLIER_TERMS_BASES)[number]
export const SUPPLIER_TERMS_MAX_DAYS = 365
export const termsPermissions = { manage: 'finance.terms.manage' } as const
export const TERMS_FAILURE = { invalid: 'TERMS_INVALID', unknownSupplier: 'TERMS_UNKNOWN_SUPPLIER', disabled: 'TERMS_DISABLED' } as const

export interface SupplierTermsSetRequest { supplierId: string; basis: SupplierTermsBasis; days: number; note?: string }
export interface SupplierTermsView {
  supplierId: string
  name: string | null
  /** Null: no terms agreed, so no due dates. */
  basis: SupplierTermsBasis | null
  days: number | null
  note: string | null
  setAt: string | null
  setById: string | null
  /** Open posted payable balance by currency, so a supplier with money owed and no terms stands out. */
  owed: Array<{ currency: string; outstandingMinor: string }>
}
export interface SupplierTermsListView { items: SupplierTermsView[]; listLimit: number; truncated: boolean }

export const PAYABLE_DUE_BUCKETS = [
  { key: 'NOT_DUE', label: 'Not yet due' },
  { key: 'OVERDUE_1_30', label: '1–30 days overdue' },
  { key: 'OVERDUE_31_60', label: '31–60 days overdue' },
  { key: 'OVERDUE_61_90', label: '61–90 days overdue' },
  { key: 'OVERDUE_91_PLUS', label: 'Over 90 days overdue' },
  { key: 'NO_DUE_DATE', label: 'No due date' },
] as const
export type PayableDueBucketKey = (typeof PAYABLE_DUE_BUCKETS)[number]['key']
export interface PayableDueCell { bucket: PayableDueBucketKey; amountMinor: string; bookings: number }
export interface PayableDueRow {
  supplierId: string
  name: string | null
  currency: string
  basis: SupplierTermsBasis | null
  days: number | null
  buckets: PayableDueCell[]
  totalMinor: string
  /** The sum of the overdue buckets. */
  overdueMinor: string
  bookings: number
}
export interface PayablesDueView { asOf: string; rows: PayableDueRow[]; listLimit: number; truncated: boolean }
