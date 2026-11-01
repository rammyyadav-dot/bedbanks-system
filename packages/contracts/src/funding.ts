/**
 * Agency funding receipts (ADR 0028 slice 2). DECLARED -> VERIFIED -> POSTED, or REJECTED. Only POSTED moves money.
 * Amounts are integer minor units serialised as strings (MinorString) end to end.
 */
export const FUNDING_RECEIPT_STATUSES = ['DECLARED', 'VERIFIED', 'POSTED', 'REJECTED'] as const
export type FundingReceiptStatus = (typeof FUNDING_RECEIPT_STATUSES)[number]
export const FUNDING_METHODS = ['BANK_TRANSFER', 'CASH_DEPOSIT'] as const
export type FundingMethod = (typeof FUNDING_METHODS)[number]
export const FUNDING_PAYER_TYPES = ['AGENCY', 'THIRD_PARTY'] as const
export type FundingPayerType = (typeof FUNDING_PAYER_TYPES)[number]
export type FundingChannel = 'ADMIN' | 'AGENT'

/** Owner decision (2026-10-04): posting a receipt of more than AED 10,000 needs a second approver. Other currencies always need one. */
export const FUNDING_SECOND_APPROVAL_THRESHOLD_MINOR: Readonly<Record<string, string>> = { AED: '1000000' }
/** Write endpoints answer 503 with this code unless the deployment sets FUNDING_ENABLED=true. Reads always work. */
export const FUNDING_DISABLED_CODE = 'FUNDING_DISABLED'

export interface FundingDeclareRequest {
  /** Admin only; the agent portal always declares for the caller's own agency. */
  agencyId?: string
  currency: string
  /** Positive whole number of minor units, as a string of digits. */
  amountMinor: string
  method: FundingMethod
  bankReference: string
  /** YYYY-MM-DD, the date the money reached the bank account. */
  valueDate: string
  payerName: string
  payerType: FundingPayerType
  notes?: string
  /** Client-generated idempotency key (8 to 80 characters). Retrying with the same key returns the same receipt. */
  requestId: string
}
export interface FundingNoteRequest { note?: string }
export interface FundingRejectRequest { reason: string }

export interface FundingReceiptView {
  id: string
  agency: { id: string; code: string; name: string }
  currency: string; amountMinor: string; method: FundingMethod; bankReference: string; valueDate: string
  payerName: string; payerType: FundingPayerType; notes: string | null
  status: FundingReceiptStatus; channel: FundingChannel
  complianceReviewRequired: boolean; complianceCleared: boolean; secondApprovalRequired: boolean
  declaredById: string; declaredAt: string
  verifiedById: string | null; verifiedAt: string | null; verificationNote: string | null
  complianceClearedById: string | null; complianceClearedAt: string | null; complianceNote: string | null
  postedById: string | null; postedAt: string | null
  rejectedById: string | null; rejectedAt: string | null; rejectionReason: string | null
  accountId: string | null; ledgerEntryId: string | null
  /** Separation of duties for the CALLER (the endpoint still re-checks it, and the permission). */
  canVerify: boolean; canClearCompliance: boolean; canPost: boolean; canReject: boolean
  /** Why the caller cannot post, when the receipt is otherwise ready; null when they can. */
  postBlockedReason: string | null
}

/** What an agency user sees of its own receipts (no staff ids). */
export interface AgentFundingReceiptView {
  id: string; currency: string; amountMinor: string; method: FundingMethod; bankReference: string; valueDate: string
  payerName: string; payerType: FundingPayerType; status: FundingReceiptStatus; declaredAt: string; postedAt: string | null; rejectionReason: string | null
  complianceReviewRequired: boolean
}
export interface AgentFundingView { enabled: boolean; agency: { id: string; code: string; name: string } | null; receipts: AgentFundingReceiptView[] }
