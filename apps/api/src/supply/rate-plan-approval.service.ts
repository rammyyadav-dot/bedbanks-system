import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { RatePlanActivationApproval, RatePlanActivationRequestInput, RatePlanApprovalDecisionInput, RatePlanApprovalExecuteResult } from '@bedbanks/contracts'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { AgentAuditService } from '../agent/audit.service'
import { PrismaService } from '../database/prisma.service'
import { transitionTarget } from './rate-plan-activation'
import { activationApprovalMode } from './rate-plan-approval-mode'
import { SupplyService } from './supply.service'

/** The permission-catalogue key (S3, approval-only, refines supply.rates.manage). */
export const RATE_PLAN_APPROVAL_ACTION = 'rate_plan.activate'
const ENTITY_TYPE = 'rate_plan'

interface BoundState { updatedAt?: string; fingerprint?: string; asOf?: string }
const bound = (approval: ApprovalView): BoundState => ((approval.proposedState ?? {}) as BoundState)
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/**
 * Four-eye activation of a rate plan (ADR 0057, S5; decisions D1 to D4).
 *
 * Request -> decide by a DIFFERENT user -> execute once. The approval is bound to the exact plan content the approver reviewed (version and a
 * fingerprint of terms and rates). Readiness is re-run at execute, so an approval never waives a check, and the status write still runs
 * on the narrow lifecycle connection inside the single-use claim. Suspension is not part of this flow.
 * Every method authorizes with `supply.rates.manage` (or `.read` for the view); the approval service itself does not check permissions.
 */
@Injectable()
export class RatePlanApprovalService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService, private readonly supply: SupplyService) {}

  private view(approval: ApprovalView, me: string): RatePlanActivationApproval {
    const isRequester = approval.requestedById === me
    return {
      id: approval.id, ratePlanId: approval.entityId, status: approval.status, requestedById: approval.requestedById, reason: approval.reason,
      decidedById: approval.decidedById, decisionReason: approval.decisionReason, decidedAt: approval.decidedAt?.toISOString() ?? null,
      executedAt: approval.executedAt?.toISOString() ?? null, createdAt: approval.createdAt.toISOString(), boundUpdatedAt: bound(approval).updatedAt ?? null,
      isRequester, canDecide: approval.status === 'PENDING' && !isRequester, canCancel: approval.status === 'PENDING' && isRequester, canExecute: approval.status === 'APPROVED',
    }
  }

  private async mine(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const approval = await this.approvals.get(tenantId, approvalId)
    if (approval.entityType !== ENTITY_TYPE || approval.action !== RATE_PLAN_APPROVAL_ACTION) throw new BadRequestException('Not a rate plan activation approval')
    return approval
  }

  /** Current plan version and content fingerprint; 404 for a plan of another tenant. */
  private facts(tenantId: string, ratePlanId: string) { return this.supply.approvalFacts(tenantId, ratePlanId) }

  async latest(tenantId: string, userId: string, ratePlanId: string): Promise<RatePlanActivationApproval | null> {
    await this.supply.assertPermission(tenantId, userId, 'supply.rates.read')
    const [latest] = await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [ratePlanId])
    return latest && latest.action === RATE_PLAN_APPROVAL_ACTION ? this.view(latest, userId) : null
  }

  async request(tenantId: string, userId: string, ratePlanId: string, body: RatePlanActivationRequestInput, httpRequestId?: string): Promise<RatePlanActivationApproval> {
    await this.supply.assertPermission(tenantId, userId, 'supply.rates.manage')
    if (activationApprovalMode() === 'off') throw new ConflictException({ code: 'RATE_PLAN_APPROVAL_NOT_REQUIRED', message: 'Activation approval is switched off in this environment; activate directly.' })
    const requestId = text(body?.requestId, 80)
    if (!requestId) throw new BadRequestException('requestId is required')
    const expected = typeof body?.expectedUpdatedAt === 'string' ? new Date(body.expectedUpdatedAt) : null
    if (!expected || Number.isNaN(expected.getTime())) throw new BadRequestException('expectedUpdatedAt is required')

    const { plan, readiness, asOf, fingerprint } = await this.facts(tenantId, ratePlanId)
    if (plan.updatedAt.getTime() !== expected.getTime()) throw new ConflictException({ code: 'RATE_PLAN_CHANGED', message: 'The rate plan changed since it was loaded. Reload and review before requesting.' })
    if (!transitionTarget('activate', plan.status)) throw new ConflictException({ code: 'RATE_PLAN_TRANSITION_NOT_ALLOWED', message: `A ${plan.status} rate plan cannot be activated.` })
    if (!readiness.ready) throw new ConflictException({ code: 'RATE_PLAN_NOT_READY', message: 'Activation readiness checks failed.', details: readiness.checks.filter((item) => !item.ok) })

    // One open request per plan. A request whose content no longer matches can never be approved or applied; it is superseded, not left blocking.
    for (const open of await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [ratePlanId])) {
      if (open.action !== RATE_PLAN_APPROVAL_ACTION || (open.status !== 'PENDING' && open.status !== 'APPROVED') || open.requestId === requestId) continue
      const state = bound(open)
      if (state.updatedAt === plan.updatedAt.toISOString() && state.fingerprint === fingerprint) throw new ConflictException({ code: 'RATE_PLAN_APPROVAL_OPEN', message: 'This rate plan already has an open activation request.' })
      const superseded = await this.prisma.withTenant(tenantId, (tx) => tx.approvalRequest.updateMany({ where: { id: open.id, tenantId, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } }))
      if (superseded.count === 1) await this.audit.record({ tenantId, userId, action: 'supply.rate_plan.activation_request_superseded', entityType: ENTITY_TYPE, entityId: ratePlanId, payload: { approvalId: open.id, requestId: httpRequestId ?? null } })
    }

    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: RATE_PLAN_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: ratePlanId, requestId, reason: String(body.reason ?? ''),
      beforeState: { status: plan.status },
      proposedState: { updatedAt: plan.updatedAt.toISOString(), fingerprint, asOf, code: plan.code },
    })
    return this.view(approval, userId)
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: RatePlanApprovalDecisionInput): Promise<RatePlanActivationApproval> {
    await this.supply.assertPermission(tenantId, userId, 'supply.rates.manage')
    const approval = await this.mine(tenantId, approvalId)
    if (decision === 'APPROVED' && approval.status === 'PENDING') {
      // An approver signs off on what is there now. If the plan moved since the request, refuse: the requester files again.
      const { plan, fingerprint } = await this.facts(tenantId, approval.entityId)
      const state = bound(approval)
      if (state.updatedAt !== plan.updatedAt.toISOString() || state.fingerprint !== fingerprint) throw new ConflictException({ code: 'RATE_PLAN_CHANGED_SINCE_REQUEST', message: 'The rate plan changed after this request was filed, so it cannot be approved. Ask for a new request.' })
    }
    const updated = await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.view(updated, userId)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<RatePlanActivationApproval> {
    await this.supply.assertPermission(tenantId, userId, 'supply.rates.manage')
    await this.mine(tenantId, approvalId)
    return this.view(await this.approvals.cancel({ tenantId, requesterId: userId, approvalId }), userId)
  }

  /** Applies the approved request once. Readiness is re-run and the content re-checked inside the same lifecycle transaction. */
  async execute(tenantId: string, userId: string, approvalId: string, httpRequestId?: string): Promise<RatePlanApprovalExecuteResult> {
    await this.supply.assertPermission(tenantId, userId, 'supply.rates.manage')
    const found = await this.mine(tenantId, approvalId)
    if (!bound(found).updatedAt || !bound(found).fingerprint || !bound(found).asOf) throw new NotFoundException('Approval carries no bound content')
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: RATE_PLAN_APPROVAL_ACTION }, async (approval) => {
      const state = bound(approval)
      if (!approval.decidedById) throw new ConflictException('Approval has no approver')
      const saved = await this.supply.activateApproved(tenantId, userId, approval.entityId, new Date(state.updatedAt!), {
        approvalId: approval.id, requestedById: approval.requestedById, approvedById: approval.decidedById, fingerprint: state.fingerprint!, asOf: state.asOf!,
      }, httpRequestId)
      return saved
    })
    return { approval: this.view(out.approval, userId), ratePlanId: out.approval.entityId, status: 'ACTIVE' }
  }
}
