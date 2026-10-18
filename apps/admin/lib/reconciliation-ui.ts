import type { ReconExceptionStatus, ReconFindingType, ReconResolutionAction, ReconRunStatus, ReconSeverity } from '@bedbanks/contracts'

/** Display text only. The meaning of a type, who may decide it and what a decision needs all come from the API. */
export const TYPE_LABEL: Record<ReconFindingType, string> = {
  MATCHED: 'Matched', ROUNDING_VARIANCE: 'Rounding variance', AMOUNT_OVERCHARGE: 'Overcharge', AMOUNT_UNDERCHARGE: 'Undercharge', CURRENCY_MISMATCH: 'Currency mismatch',
  UNINVOICED_SURCHARGE: 'Un-invoiced surcharge', UNMATCHED_LINE: 'Unmatched line', AMBIGUOUS_REFERENCE: 'Ambiguous reference', DUPLICATE_LINE: 'Duplicate line', NET_UNKNOWN: 'Net not recorded',
  CHARGE_ON_CANCELLED: 'Charge on cancelled booking', CREDIT_MATCHED: 'Credit matched', CREDIT_VARIANCE: 'Credit differs', CREDIT_WITHOUT_CANCELLATION: 'Credit without cancellation',
  CREDIT_AMOUNT_UNKNOWN: 'Expected credit unknown', MISSING_FROM_STATEMENT: 'Missing from statement', CREDIT_NOT_RECEIVED: 'Credit not received',
}

export const ACTION_LABEL: Record<ReconResolutionAction, string> = {
  ACCEPT_STATEMENT: 'Accept the statement amount', KEEP_LEDGER_AND_DISPUTE: 'Keep our figure and dispute with the supplier', WRITE_OFF_VARIANCE: 'Write off the variance',
  REJECT_STATEMENT_LINE: 'Reject this statement line', ACKNOWLEDGE: 'Acknowledge, no action needed',
}

export const STATUS_LABEL: Record<ReconExceptionStatus, string> = { OPEN: 'Open', DISPUTED: 'Disputed', PENDING_APPROVAL: 'Awaiting second person', RESOLVED: 'Resolved' }
export const RUN_LABEL: Record<ReconRunStatus, string> = { QUEUED: 'Queued', RUNNING: 'Running', SUCCEEDED: 'Matched', FAILED: 'Failed' }

export const severityTone = (s: ReconSeverity): 'bad' | 'warn' | 'neutral' => (s === 'HIGH' ? 'bad' : s === 'MEDIUM' ? 'warn' : 'neutral')
export const statusTone = (s: ReconExceptionStatus): 'ok' | 'warn' | 'bad' | 'neutral' => (s === 'RESOLVED' ? 'ok' : s === 'PENDING_APPROVAL' ? 'warn' : s === 'DISPUTED' ? 'neutral' : 'bad')
export const runTone = (s: ReconRunStatus): 'ok' | 'warn' | 'bad' | 'neutral' => (s === 'SUCCEEDED' ? 'ok' : s === 'FAILED' ? 'bad' : 'warn')
export const runIsActive = (s: ReconRunStatus | undefined) => s === 'QUEUED' || s === 'RUNNING'

/** Stable run error codes to words an operator can act on. */
export const RUN_ERROR_TEXT: Record<string, string> = {
  SCOPE_TOO_LARGE: 'The supplier has too many bookings in this period to match in one run. Split the statement by period.',
  MAX_ATTEMPTS: 'The run could not finish after three attempts. Ask engineering to check the worker.',
  RUN_ERROR: 'The run failed. It will be retried.',
}
