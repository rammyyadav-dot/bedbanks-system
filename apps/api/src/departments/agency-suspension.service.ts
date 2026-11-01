import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { AGENCY_SUSPENSION_CHANGES, type AgencyPage, type AgencySuspensionApprovalView, type AgencySuspensionChange, type AgencySuspensionDecision, type AgencySuspensionRequest, type AgencySuspensionResult, type AgencyView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { enumParam, textParam } from '../admin-operations/query-params'
import { ClientsService } from './clients.service'

export const AGENCY_SUSPEND_APPROVAL_ACTION = 'agency.suspend'
export const AGENCY_ENTITY_TYPE = 'agency'
const TARGET: Record<AgencySuspensionChange, 'SUSPENDED' | 'ACTIVE'> = { SUSPEND: 'SUSPENDED', REINSTATE: 'ACTIVE' }

/**
 * Suspending or reinstating an agency (ADR 0020). Both go through one single-use maker-checker approval; a plain agency edit can
 * never set or clear SUSPENDED. Enforcement of the status is in AgencySuspensionGuard, not here.
 */
@Injectable()
export class AgencySuspensionService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService, private readonly clients: ClientsService) {}

  private changeOf(a: ApprovalView): AgencySuspensionChange {
    return (a.proposedState as { change?: string } | null)?.change === 'REINSTATE' ? 'REINSTATE' : 'SUSPEND'
  }

  approvalView(a: ApprovalView | undefined, me: string): AgencySuspensionApprovalView | null {
    if (!a) return null
    return { id: a.id, change: this.changeOf(a), status: a.status, requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason, canDecide: a.requestedById !== me && a.status === 'PENDING', canCancel: a.requestedById === me && a.status === 'PENDING', canExecute: a.status === 'APPROVED' }
  }

  /** The open (pending or approved) request for each agency, newest first wins. */
  async openFor(tenantId: string, agencyIds: string[], me: string): Promise<Map<string, AgencySuspensionApprovalView>> {
    const out = new Map<string, AgencySuspensionApprovalView>()
    if (agencyIds.length === 0) return out
    for (const a of await this.approvals.listForEntities(tenantId, AGENCY_ENTITY_TYPE, agencyIds)) {
      if (a.action !== AGENCY_SUSPEND_APPROVAL_ACTION || !(a.status === 'PENDING' || a.status === 'APPROVED') || out.has(a.entityId)) continue
      out.set(a.entityId, this.approvalView(a, me)!)
    }
    return out
  }

  /** The agency list with each agency's open suspension request attached. */
  async list(tenantId: string, userId: string, query: Record<string, unknown>): Promise<AgencyPage> {
    const page = await this.clients.list(tenantId, query)
    const open = await this.openFor(tenantId, page.items.map((a) => a.id), userId)
    return { ...page, items: page.items.map((a) => ({ ...a, suspension: open.get(a.id) ?? null })) }
  }

  async detail(tenantId: string, userId: string, agencyId: string): Promise<AgencyView> {
    const agency = await this.clients.get(tenantId, agencyId)
    return { ...agency, suspension: (await this.openFor(tenantId, [agency.id], userId)).get(agency.id) ?? null }
  }

  async request(tenantId: string, userId: string, agencyId: string, body: AgencySuspensionRequest): Promise<AgencyView> {
    const agency = await this.clients.get(tenantId, agencyId)
    const change = enumParam('change', body?.change, AGENCY_SUSPENSION_CHANGES)
    if (!change) throw new BadRequestException('change must be SUSPEND or REINSTATE')
    if (change === 'SUSPEND' && agency.status === 'SUSPENDED') throw new ConflictException('The agency is already suspended')
    if (change === 'REINSTATE' && agency.status !== 'SUSPENDED') throw new ConflictException('Only a suspended agency can be reinstated')
    const requestId = textParam('requestId', body?.requestId, 80)
    if (!requestId) throw new BadRequestException('requestId is required')
    const open = (await this.approvals.listForEntities(tenantId, AGENCY_ENTITY_TYPE, [agency.id])).find((a) => a.action === AGENCY_SUSPEND_APPROVAL_ACTION && (a.status === 'PENDING' || a.status === 'APPROVED') && a.requestId !== requestId)
    if (open) throw new ConflictException('This agency already has an open suspension request')
    await this.approvals.request({
      tenantId, requesterId: userId, action: AGENCY_SUSPEND_APPROVAL_ACTION, entityType: AGENCY_ENTITY_TYPE, entityId: agency.id, requestId, reason: String(body.reason ?? ''),
      beforeState: { status: agency.status }, proposedState: { change, status: TARGET[change], code: agency.code },
    })
    return this.detail(tenantId, userId, agency.id)
  }

  private async assertAgencyApproval(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId)
    if (a.entityType !== AGENCY_ENTITY_TYPE || a.action !== AGENCY_SUSPEND_APPROVAL_ACTION) throw new BadRequestException('Not an agency suspension approval')
    return a
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: AgencySuspensionDecision): Promise<AgencyView> {
    const a = await this.assertAgencyApproval(tenantId, approvalId)
    await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.detail(tenantId, userId, a.entityId)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<AgencyView> {
    const a = await this.assertAgencyApproval(tenantId, approvalId)
    await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    return this.detail(tenantId, userId, a.entityId)
  }

  /** Applies the approved change once. The agency must still be in the state it was approved from. */
  async execute(tenantId: string, userId: string, approvalId: string): Promise<AgencySuspensionResult> {
    await this.assertAgencyApproval(tenantId, approvalId)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: AGENCY_SUSPEND_APPROVAL_ACTION }, async (approval) => {
      const change = this.changeOf(approval)
      const from = (approval.beforeState as { status?: string } | null)?.status
      return this.prisma.withTenant(tenantId, async (tx) => {
        const moved = await tx.agency.updateMany({ where: { id: approval.entityId, tenantId, status: from as 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' }, data: { status: TARGET[change] } })
        if (moved.count !== 1) {
          const exists = await tx.agency.findFirst({ where: { id: approval.entityId, tenantId }, select: { id: true } })
          if (!exists) throw new NotFoundException('Agency not found')
          throw new ConflictException('The agency changed after this request was approved')
        }
        return change
      })
    })
    const change = out.result
    await this.audit.record({ tenantId, userId, action: change === 'SUSPEND' ? 'agency.suspended' : 'agency.reinstated', entityType: AGENCY_ENTITY_TYPE, entityId: out.approval.entityId, payload: { approvalId } })
    return { approval: this.approvalView(out.approval, userId)!, agency: await this.detail(tenantId, userId, out.approval.entityId) }
  }
}
