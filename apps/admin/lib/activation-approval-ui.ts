import type { RatePlanActivationApproval } from '@bedbanks/contracts'

/**
 * What the Activate control shows for a plan when activation needs a second person (ADR 0057, S5). Display only: the API enforces every rule,
 * including who may decide, and these flags come from the server for the signed-in user.
 */
export type ApprovalStage = 'request' | 'awaiting-other' | 'decide' | 'execute'

export function approvalStage(approval: RatePlanActivationApproval | null): ApprovalStage {
  if (!approval) return 'request'
  if (approval.status === 'APPROVED' && approval.canExecute) return 'execute'
  if (approval.status === 'PENDING') return approval.canDecide ? 'decide' : 'awaiting-other'
  return 'request' // rejected, cancelled or already used: a new request is the only way forward
}

export const STAGE_TITLE: Record<ApprovalStage, string> = {
  request: 'Request activation',
  'awaiting-other': 'Waiting for a second approver',
  decide: 'Review and decide',
  execute: 'Approved: activate now',
}

/** One idempotency key per button press; a retry of the same press reuses it so a lost response cannot file two requests. */
export const newRequestId = (random: () => string = () => globalThis.crypto.randomUUID()): string => `act-${random()}`

export const approvalSummary = (approval: RatePlanActivationApproval): string =>
  `${approval.status.toLowerCase()} · requested ${approval.createdAt.slice(0, 10)}${approval.decidedAt ? ` · decided ${approval.decidedAt.slice(0, 10)}` : ''}`
