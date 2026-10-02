import { BadRequestException, Injectable } from '@nestjs/common'
import type { ReconciliationApprovalDecision, ReconciliationApprovalExecution, ReconciliationApprovalRequest, ReconciliationApprovalView } from '@bedbanks/contracts'
import { ApprovalService, type ApprovalStatus, type ApprovalView } from '../approvals/approval.service'
import { BookingReconciliationService } from '../agent/booking-reconciliation.service'
import { OperationsTransactionsService } from './operations-transactions.service'
import { enumParam, intParam, paged, pageParams, textParam } from './query-params'

export const RECONCILIATION_APPROVAL_ACTION = 'reconciliation.resolve'
const ENTITY_TYPE = 'reconciliation_run'
const STATUSES: readonly ApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXECUTED']

/**
 * Maker-checker in front of a reconciliation run. It adds an approved, single-use path; it does not change what a run does
 * (the existing idempotent reconcile, which never overrides a status) and it does not remove the direct run.
 * Both the requester and the approver need booking.reconcile (enforced by the controller); the approval service
 * guarantees they are different people, the request is idempotent, and an approval runs at most once.
 */
@Injectable()
export class OperationsReconciliationApprovalsService {
  constructor(private readonly approvals: ApprovalService, private readonly tx: OperationsTransactionsService, private readonly reconciliation: BookingReconciliationService) {}

  private view(a: ApprovalView, me: string): ReconciliationApprovalView {
    const p = (a.proposedState ?? {}) as { staleMinutes?: number; prebookMaxMinutes?: number }
    const before = (a.beforeState ?? {}) as { stalledHolds?: number }
    return {
      id: a.id, status: a.status, requestedById: a.requestedById, reason: a.reason,
      parameters: { staleMinutes: p.staleMinutes ?? null, prebookMaxMinutes: p.prebookMaxMinutes ?? null },
      stalledHoldsAtRequest: typeof before.stalledHolds === 'number' ? before.stalledHolds : null,
      decidedById: a.decidedById, decisionReason: a.decisionReason, decidedAt: a.decidedAt?.toISOString() ?? null,
      executedById: a.executedById, executedAt: a.executedAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(),
      canDecide: a.requestedById !== me && a.status === 'PENDING',
      canCancel: a.requestedById === me && a.status === 'PENDING',
      canExecute: a.status === 'APPROVED',
    }
  }

  async request(tenantId: string, userId: string, body: ReconciliationApprovalRequest): Promise<ReconciliationApprovalView> {
    const requestId = textParam('requestId', body?.requestId, 80)
    if (!requestId) throw new BadRequestException('requestId is required')
    const staleMinutes = intParam('staleMinutes', body.staleMinutes, 1, 10_080)
    const prebookMaxMinutes = intParam('prebookMaxMinutes', body.prebookMaxMinutes, 15, 10_080)
    // Evidence for the approver: what the stalled-hold queue shows now (read-only dry run).
    const dry = await this.reconciliation.reconcileStale({ tenantId, userId, requestId: `${requestId}:evidence`, ...(staleMinutes !== undefined && { staleMinutes }), ...(prebookMaxMinutes !== undefined && { prebookMaxMinutes }), dryRun: true })
    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: RECONCILIATION_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: tenantId, requestId, reason: String(body.reason ?? ''),
      beforeState: { stalledHolds: dry.examined },
      proposedState: { ...(staleMinutes !== undefined && { staleMinutes }), ...(prebookMaxMinutes !== undefined && { prebookMaxMinutes }) },
    })
    return this.view(approval, userId)
  }

  async list(tenantId: string, userId: string, query: Record<string, unknown>) {
    const page = pageParams(query)
    const status = enumParam('status', query.status, STATUSES)
    const rows = await this.approvals.list(tenantId, { ...(status && { status }), entityType: ENTITY_TYPE, limit: 100 })
    const items = rows.slice(page.skip, page.skip + page.take).map((a) => this.view(a, userId))
    return paged(items, page, rows.length)
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: ReconciliationApprovalDecision): Promise<ReconciliationApprovalView> {
    await this.assertOwn(tenantId, approvalId)
    return this.view(await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') }), userId)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<ReconciliationApprovalView> {
    await this.assertOwn(tenantId, approvalId)
    return this.view(await this.approvals.cancel({ tenantId, requesterId: userId, approvalId }), userId)
  }

  /** Runs the existing reconcile once, with exactly the approved parameters. Anything in the request body is ignored. */
  async execute(tenantId: string, userId: string, approvalId: string, requestId: string): Promise<ReconciliationApprovalExecution> {
    await this.assertOwn(tenantId, approvalId)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: RECONCILIATION_APPROVAL_ACTION }, async (a) => {
      const p = (a.proposedState ?? {}) as { staleMinutes?: number; prebookMaxMinutes?: number }
      return this.tx.reconcile(tenantId, userId, `${requestId}:approval:${a.id}`, { ...(p.staleMinutes !== undefined && { staleMinutes: p.staleMinutes }), ...(p.prebookMaxMinutes !== undefined && { prebookMaxMinutes: p.prebookMaxMinutes }) })
    })
    return { approval: this.view(out.approval, userId), result: out.result }
  }

  /** Only reconciliation approvals are reachable here, even though ids are global to the tenant. */
  private async assertOwn(tenantId: string, approvalId: string): Promise<void> {
    const a = await this.approvals.get(tenantId, approvalId)
    if (a.entityType !== ENTITY_TYPE || a.action !== RECONCILIATION_APPROVAL_ACTION) throw new BadRequestException('Not a reconciliation approval')
  }
}
