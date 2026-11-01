/**
 * Supplier statement reconciliation and the dispute queue (ADR 0070).
 * A supplier settlement statement is imported, matched against internal ledger items by booking reference and exact net amount, and every
 * difference becomes an exception that a finance operator decides. Amounts are integer minor units serialised as strings (MinorString).
 * Nothing here posts to the ledger or moves money: a decision is a recorded, audited, maker-checked statement of intent (ADR 0054).
 */
export const STATEMENT_LINE_KINDS = ['CHARGE', 'CREDIT', 'SURCHARGE'] as const
export type StatementLineKindName = (typeof STATEMENT_LINE_KINDS)[number]

export const RECON_RUN_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const
export type ReconRunStatus = (typeof RECON_RUN_STATUSES)[number]

export const RECON_FINDING_TYPES = [
  'MATCHED', 'ROUNDING_VARIANCE', 'AMOUNT_OVERCHARGE', 'AMOUNT_UNDERCHARGE', 'CURRENCY_MISMATCH', 'UNINVOICED_SURCHARGE', 'UNMATCHED_LINE',
  'AMBIGUOUS_REFERENCE', 'DUPLICATE_LINE', 'NET_UNKNOWN', 'CHARGE_ON_CANCELLED', 'CREDIT_MATCHED', 'CREDIT_VARIANCE', 'CREDIT_WITHOUT_CANCELLATION',
  'CREDIT_AMOUNT_UNKNOWN', 'MISSING_FROM_STATEMENT', 'CREDIT_NOT_RECEIVED',
] as const
export type ReconFindingType = (typeof RECON_FINDING_TYPES)[number]

/** OPEN: needs a decision. DISPUTED: raised with the supplier, waiting. PENDING_APPROVAL: a decision awaits a second person. RESOLVED: closed. */
export const RECON_EXCEPTION_STATUSES = ['OPEN', 'DISPUTED', 'PENDING_APPROVAL', 'RESOLVED'] as const
export type ReconExceptionStatus = (typeof RECON_EXCEPTION_STATUSES)[number]

export const RECON_RESOLUTION_ACTIONS = ['ACCEPT_STATEMENT', 'KEEP_LEDGER_AND_DISPUTE', 'WRITE_OFF_VARIANCE', 'REJECT_STATEMENT_LINE', 'ACKNOWLEDGE'] as const
export type ReconResolutionAction = (typeof RECON_RESOLUTION_ACTIONS)[number]

/** Resolution recorded when a re-run finds that an exception no longer exists. */
export const RECON_AUTO_RESOLUTION = 'AUTO_MATCHED' as const
export type ReconResolution = ReconResolutionAction | typeof RECON_AUTO_RESOLUTION

export type ReconSeverity = 'LOW' | 'MEDIUM' | 'HIGH'
export type ReconSort = 'newest' | 'oldest'

/** Write endpoints answer 503 with this code unless the deployment sets FINANCE_RECONCILIATION_ENABLED=true. Reads always work. */
export const RECONCILIATION_DISABLED_CODE = 'FINANCE_RECONCILIATION_DISABLED'
/** Largest statement accepted in one import. */
export const STATEMENT_MAX_LINES = 5000
/**
 * Streamed import (ADR 0074): `POST statements/stream`, `Content-Type: application/x-ndjson`. Line 1 is the statement header
 * (`supplierId`, `statementRef`, `periodStart`, `periodEnd`, `requestId`), every further line is one `StatementLineRequest`. Same validation, same
 * idempotency and the same content hash as the JSON import, so a statement cannot be imported twice by switching channels. The line limit is the same
 * as the JSON import's until the reconciliation run has been load-tested above it.
 */
export const STATEMENT_STREAM_CONTENT_TYPE = 'application/x-ndjson'
/** Ceiling on the whole upload. 5,000 lines of long references are under 1 MB; this leaves headroom and still bounds a hostile client. */
export const STATEMENT_STREAM_MAX_BYTES = 4 * 1024 * 1024
/** Ceiling on one line, so a missing newline cannot grow a buffer without bound. */
export const STATEMENT_STREAM_MAX_LINE_BYTES = 4096

export interface StatementLineRequest {
  /** The booking reference the supplier quotes: ours or theirs. */
  reference: string
  kind: StatementLineKindName
  currency: string
  /** Positive major-unit decimal string, e.g. "123.45". Converted with the currency exponent; extra decimals are refused. */
  amount: string
}

export interface StatementImportRequest {
  supplierId: string
  /** The supplier's statement number. Unique per supplier. */
  statementRef: string
  /** YYYY-MM-DD, inclusive. Payable bookings with check-out in the period must appear on the statement or are reported as missing. */
  periodStart: string
  periodEnd: string
  lines: StatementLineRequest[]
  /** Client-generated idempotency key (8 to 80 characters). Retrying returns the same statement. */
  requestId: string
}

export interface StatementView {
  id: string
  supplier: { id: string; displayName: string }
  statementRef: string
  periodStart: string
  periodEnd: string
  lineCount: number
  importedById: string
  importedAt: string
  latestRun: ReconRunView | null
  exceptions: { open: number; disputed: number; pendingApproval: number; resolved: number }
}

export interface ReconRunRequest {
  /** Same-currency differences up to this many minor units are a rounding variance. Default 0: exact match only. Maximum 1000. */
  roundingToleranceMinor?: string
  requestId: string
}

export interface ReconRunView {
  id: string
  statementId: string
  status: ReconRunStatus
  roundingToleranceMinor: string
  requestedById: string
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
  attempts: number
  /** Stable code only; never a raw message. */
  errorCode: string | null
  matched: number | null
  exceptions: number | null
}

export interface SettlementRow { currency: string; chargesMinor: string; creditsMinor: string; statementNetMinor: string; matchedMinor: string; exceptionMinor: string }

export interface StatementDetail { statement: StatementView; runs: ReconRunView[]; settlement: SettlementRow[]; definitions: Record<string, string> }

export interface ReconExceptionView {
  id: string
  statementId: string
  statementRef: string
  supplier: { id: string; displayName: string }
  type: ReconFindingType
  severity: ReconSeverity
  hint: string
  status: ReconExceptionStatus
  currency: string
  statementMinor: string | null
  ledgerMinor: string | null
  /** statement minus ledger, same currency only. Null: cannot be computed (currency mismatch, unknown or missing side). */
  varianceMinor: string | null
  reference: string | null
  lineNo: number | null
  booking: { id: string; reference: string } | null
  allowedActions: ReconResolutionAction[]
  proposedAction: ReconResolutionAction | null
  proposedById: string | null
  resolution: ReconResolution | null
  resolvedById: string | null
  resolvedAt: string | null
  createdAt: string
  /** For the CALLER: the endpoints still enforce permission and separation of duties. */
  canPropose: boolean
  canDecide: boolean
}

export interface ReconDecisionView { id: string; action: string; fromStatus: ReconExceptionStatus; toStatus: ReconExceptionStatus; resolution: ReconResolution | null; reason: string | null; actorId: string | null; createdAt: string }
export interface ReconExceptionDetail { exception: ReconExceptionView; history: ReconDecisionView[]; secondApprovalRequired: Partial<Record<ReconResolutionAction, boolean>> }

export interface ReconExceptionSummary {
  byStatus: Record<ReconExceptionStatus, number>
  byType: Partial<Record<ReconFindingType, number>>
  /** Per currency, never added: the absolute variance still open or disputed. */
  openVarianceByCurrency: Array<{ currency: string; absoluteVarianceMinor: string; unknownAmountCount: number }>
}

export interface ReconProposeRequest { action: ReconResolutionAction; reason: string }
export interface ReconDecisionRequest { reason: string }

export const reconciliationPermissions = { run: 'finance.reconcile.run', resolve: 'finance.reconcile.resolve' } as const
