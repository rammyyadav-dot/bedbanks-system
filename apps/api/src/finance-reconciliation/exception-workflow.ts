import { EXCEPTION_RULES, needsSecondApproval, type Finding, type FindingType } from '@bedbanks/money'
import type { ReconExceptionStatus, ReconResolutionAction } from '@bedbanks/contracts'

export interface WorkflowSubject {
  status: ReconExceptionStatus
  type: FindingType
  currency: string
  statementMinor: bigint | null
  ledgerMinor: bigint | null
  varianceMinor: bigint | null
  proposedAction: ReconResolutionAction | null
  proposedById: string | null
}

export interface Refusal { kind: 'refused'; code: string; message: string; status: 403 | 409 | 422 }

/** The columns a decision writes. Resolved/Proposed fields not listed are cleared by the caller's `OPEN` reset. */
export interface Transition {
  kind: 'ok'
  to: ReconExceptionStatus
  proposedAction: ReconResolutionAction | null
  proposedById: string | null
  secondApprovalRequired: boolean
  resolution: ReconResolutionAction | null
  resolvedById: string | null
  resolved: boolean
}

const refuse = (status: Refusal['status'], code: string, message: string): Refusal => ({ kind: 'refused', code, message, status })

/** Actions available on an exception, from the rule table. Clean findings have none. */
export function allowedActions(type: FindingType, varianceMinor: bigint | null): ReconResolutionAction[] {
  if (type === 'MATCHED' || type === 'CREDIT_MATCHED') return []
  return EXCEPTION_RULES[type].actions.filter((a) => a !== 'WRITE_OFF_VARIANCE' || varianceMinor !== null) as ReconResolutionAction[]
}

/** Whether a decision on this exception needs a second person, per action. */
export function secondApprovalByAction(s: Pick<WorkflowSubject, 'type' | 'currency' | 'statementMinor' | 'ledgerMinor' | 'varianceMinor'>): Partial<Record<ReconResolutionAction, boolean>> {
  return Object.fromEntries(allowedActions(s.type, s.varianceMinor).map((a) => [a, needsSecondApproval(a, s as Pick<Finding, 'currency' | 'statementMinor' | 'ledgerMinor' | 'varianceMinor'>)]))
}

/**
 * Maker step. KEEP_LEDGER_AND_DISPUTE and ACKNOWLEDGE move no money and close at once (a dispute parks the exception as DISPUTED). Any other
 * decision at or above the threshold, or with an unknown amount, waits for a different person. Recording a decision never posts to the ledger (ADR 0070).
 */
export function propose(s: WorkflowSubject, action: ReconResolutionAction, actorId: string): Transition | Refusal {
  if (s.status === 'RESOLVED') return refuse(409, 'RECON_ALREADY_RESOLVED', 'This exception is already resolved')
  if (s.status === 'PENDING_APPROVAL') return refuse(409, 'RECON_DECISION_PENDING', 'A decision is already waiting for a second person')
  if (!allowedActions(s.type, s.varianceMinor).includes(action)) return refuse(422, 'RECON_ACTION_NOT_ALLOWED', `${action} is not available for ${s.type}`)
  if (action === 'KEEP_LEDGER_AND_DISPUTE') {
    if (s.status === 'DISPUTED') return refuse(409, 'RECON_ALREADY_DISPUTED', 'This exception is already disputed')
    return { kind: 'ok', to: 'DISPUTED', proposedAction: action, proposedById: actorId, secondApprovalRequired: false, resolution: null, resolvedById: null, resolved: false }
  }
  if (needsSecondApproval(action, s as Pick<Finding, 'currency' | 'statementMinor' | 'ledgerMinor' | 'varianceMinor'>)) {
    return { kind: 'ok', to: 'PENDING_APPROVAL', proposedAction: action, proposedById: actorId, secondApprovalRequired: true, resolution: null, resolvedById: null, resolved: false }
  }
  return { kind: 'ok', to: 'RESOLVED', proposedAction: action, proposedById: actorId, secondApprovalRequired: false, resolution: action, resolvedById: actorId, resolved: true }
}

/** Checker step: a different person confirms the pending decision. */
export function approve(s: WorkflowSubject, actorId: string): Transition | Refusal {
  if (s.status !== 'PENDING_APPROVAL' || !s.proposedAction) return refuse(409, 'RECON_NOTHING_PENDING', 'No decision is waiting for approval')
  if (s.proposedById === actorId) return refuse(403, 'RECON_SEPARATION_OF_DUTIES', 'The person who proposed a decision cannot approve it')
  return { kind: 'ok', to: 'RESOLVED', proposedAction: s.proposedAction, proposedById: s.proposedById, secondApprovalRequired: true, resolution: s.proposedAction, resolvedById: actorId, resolved: true }
}

/** Checker step: a different person sends the exception back to the queue. */
export function reject(s: WorkflowSubject, actorId: string): Transition | Refusal {
  if (s.status !== 'PENDING_APPROVAL') return refuse(409, 'RECON_NOTHING_PENDING', 'No decision is waiting for approval')
  if (s.proposedById === actorId) return refuse(403, 'RECON_SEPARATION_OF_DUTIES', 'The person who proposed a decision cannot reject it as the checker')
  return { kind: 'ok', to: 'OPEN', proposedAction: null, proposedById: null, secondApprovalRequired: false, resolution: null, resolvedById: null, resolved: false }
}
