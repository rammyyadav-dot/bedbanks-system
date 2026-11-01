import type { MinorString, Paged } from './operations'

/**
 * Ledger adjustments and reversals on an agency account (ADR 0100). A finance user proposes; a different finance user approves or rejects. Nothing moves until approval, which posts exactly
 * one ledger entry in the same transaction:
 *   ADJUSTMENT  a reasoned correction that credits or debits the account (bank fee, unidentified credit allocated, correction, goodwill);
 *   REVERSAL    a received payment taken back (bank recall, chargeback, duplicate payment), linked to the POSTED funding receipt it reverses. Never above what the receipt paid.
 * Amounts are integer minor units serialised as strings, in the account currency; currencies are never converted.
 */
export const LEDGER_ADJUSTMENT_KINDS = ['ADJUSTMENT', 'REVERSAL'] as const
export type LedgerAdjustmentKindName = (typeof LEDGER_ADJUSTMENT_KINDS)[number]

export const LEDGER_ADJUSTMENT_DIRECTIONS = ['CREDIT', 'DEBIT'] as const
export type LedgerAdjustmentDirectionName = (typeof LEDGER_ADJUSTMENT_DIRECTIONS)[number]

/** Reasons an ADJUSTMENT may carry, and the reasons a REVERSAL may carry. A reason belongs to one kind. */
export const LEDGER_ADJUSTMENT_REASONS = ['BANK_FEE', 'UNIDENTIFIED_CREDIT_ALLOCATED', 'CORRECTION', 'GOODWILL'] as const
export const LEDGER_REVERSAL_REASONS = ['PAYMENT_RECALL', 'CHARGEBACK', 'DUPLICATE_PAYMENT'] as const
export const LEDGER_ADJUSTMENT_ALL_REASONS = [...LEDGER_ADJUSTMENT_REASONS, ...LEDGER_REVERSAL_REASONS] as const
export type LedgerAdjustmentReasonName = (typeof LEDGER_ADJUSTMENT_ALL_REASONS)[number]

export const LEDGER_ADJUSTMENT_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const
export type LedgerAdjustmentStatusName = (typeof LEDGER_ADJUSTMENT_STATUSES)[number]

/** Writes answer 503 with LEDGER_ADJUSTMENTS_DISABLED unless the deployment sets LEDGER_ADJUSTMENTS_ENABLED=true. Reads always work. */
export const LEDGER_ADJUSTMENT_FAILURE = {
  disabled: 'LEDGER_ADJUSTMENTS_DISABLED',
  invalid: 'LEDGER_ADJUSTMENT_INVALID',
  notFound: 'LEDGER_ADJUSTMENT_NOT_FOUND',
  agencyNotFound: 'LEDGER_ADJUSTMENT_AGENCY_NOT_FOUND',
  noAccount: 'LEDGER_ADJUSTMENT_NO_ACCOUNT',
  receiptNotFound: 'LEDGER_ADJUSTMENT_RECEIPT_NOT_FOUND',
  receiptNotPosted: 'LEDGER_ADJUSTMENT_RECEIPT_NOT_POSTED',
  receiptMismatch: 'LEDGER_ADJUSTMENT_RECEIPT_MISMATCH',
  exceedsReceipt: 'LEDGER_ADJUSTMENT_EXCEEDS_RECEIPT',
  requestReused: 'LEDGER_ADJUSTMENT_REQUEST_REUSED',
  decided: 'LEDGER_ADJUSTMENT_DECIDED',
  ownProposal: 'LEDGER_ADJUSTMENT_OWN_PROPOSAL',
  changed: 'LEDGER_ADJUSTMENT_CHANGED',
} as const

export const ledgerAdjustmentPermissions = { propose: 'finance.adjustment.propose', approve: 'finance.adjustment.approve' } as const

export interface LedgerAdjustmentProposeRequest {
  /** Client-generated idempotency key (8 to 80 characters). Retrying returns the same proposal. */
  requestId: string
  kind: LedgerAdjustmentKindName
  agencyId: string
  /** ISO-4217 alpha code of the agency account. The account must already exist. */
  currency: string
  /** ADJUSTMENT only: whether the account is credited or debited. A REVERSAL always debits and must omit this. */
  direction?: LedgerAdjustmentDirectionName
  /** Positive whole number of minor units, digits only. The sign is set by `direction` or the kind. */
  amountMinor: string
  reason: LedgerAdjustmentReasonName
  /** Why, in words (3 to 500 characters). Do not put payer or guest personal data here. */
  note: string
  /** REVERSAL only: the POSTED funding receipt being taken back. */
  fundingReceiptId?: string
}

export interface LedgerAdjustmentDecisionRequest { reason?: string }

export interface LedgerAdjustmentView {
  id: string
  kind: LedgerAdjustmentKindName
  agencyId: string
  agencyName: string | null
  currency: string
  direction: LedgerAdjustmentDirectionName
  /** Magnitude; the direction says which way the account moves. */
  amountMinor: MinorString
  reason: LedgerAdjustmentReasonName
  note: string
  fundingReceiptId: string | null
  status: LedgerAdjustmentStatusName
  proposedById: string
  proposedAt: string
  decidedById: string | null
  decidedAt: string | null
  decisionReason: string | null
  /** Set once approved: the ADJUSTMENT or REVERSAL entry on the agency account. */
  ledgerEntryId: string | null
  /** For the CALLER: the endpoint still enforces permission and separation of duties. */
  canDecide: boolean
}

export type LedgerAdjustmentPage = Paged<LedgerAdjustmentView>
