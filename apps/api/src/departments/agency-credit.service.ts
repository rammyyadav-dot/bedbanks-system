import { isDatabasePermissionDenied } from '../database/db-errors'
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { AGENCY_CREDIT_NEAR_LIMIT_PERCENT, type AgencyCreditApprovalView, AgencyCreditDecision, AgencyCreditLimitRequest, AgencyCreditResult, AgencyCreditView, AgencyPage, AgencyView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { accountAging, agencyPosition, overdueView, type AgencyPosition } from '../agent/agency-account'
import type { Aging } from '../agent/credit-aging'
import { defaultSettlementCurrency } from '../agent/currency'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { textParam } from '../admin-operations/query-params'
import { AgencySuspensionService } from './agency-suspension.service'

export const CREDIT_LIMIT_APPROVAL_ACTION = 'credit_limit.approve'
export const CREDIT_ENTITY_TYPE = 'agency_credit_limit'
const OPEN = new Set(['PENDING', 'APPROVED'])
const MINOR = /^(0|[1-9][0-9]{0,17})$/

type Stored = { currency: string | null; limitMinor: string | null }

/**
 * Setting, changing or removing an agency credit limit (ADR 0024), which is the agency account's CREDIT LINE (ADR 0028 slice 3). Goes
 * through one single-use maker-checker approval; it is spent against at hold time (assertAgencyCredit) and at prebook (authorization). Lowering a limit below current commitments does not touch existing holds.
 */
@Injectable()
export class AgencyCreditService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService, private readonly suspension: AgencySuspensionService) {}

  private state(a: ApprovalView, key: 'beforeState' | 'proposedState'): Stored {
    const s = (a[key] ?? {}) as { currency?: string | null; limitMinor?: string | null }
    return { currency: s.currency ?? null, limitMinor: s.limitMinor ?? null }
  }

  private approvalView(a: ApprovalView, me: string): AgencyCreditApprovalView {
    const proposed = this.state(a, 'proposedState'); const before = this.state(a, 'beforeState')
    return {
      id: a.id, status: a.status, currency: proposed.currency, limitMinor: proposed.limitMinor, previousLimitMinor: before.limitMinor, reason: a.reason,
      requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason,
      canDecide: a.requestedById !== me && a.status === 'PENDING', canCancel: a.requestedById === me && a.status === 'PENDING', canExecute: a.status === 'APPROVED',
    }
  }

  private async openFor(tenantId: string, agencyId: string): Promise<ApprovalView | undefined> {
    return (await this.approvals.listForEntities(tenantId, CREDIT_ENTITY_TYPE, [agencyId])).find((a) => a.action === CREDIT_LIMIT_APPROVAL_ACTION && OPEN.has(a.status))
  }

  /** The agency's credit line, its spending position (ADR 0028 slice 3) and its open change request. */
  async credit(tenantId: string, me: string, agencyId: string): Promise<AgencyCreditView> {
    const limit = await this.prisma.withTenant(tenantId, (tx) => tx.agencyCreditLimit.findFirst({ where: { tenantId, agencyId } }))
    const open = await this.openFor(tenantId, agencyId)
    const openView = open ? this.approvalView(open, me) : null
    const limitView = limit ? { currency: limit.currency, limitMinor: limit.limitMinor.toString() } : null
    const currency = limit?.currency ?? defaultSettlementCurrency()
    let position: AgencyPosition
    let aging: Aging
    try {
      ;[position, aging] = await this.prisma.withTenant(tenantId, async (tx) => {
        const p = await agencyPosition(tx, tenantId, agencyId, currency)
        return [p, await accountAging(tx, tenantId, p.accountId)] as const
      })
    } catch (error) {
      // The ledger and holds are privileged reads for the API role. Report the amounts as unknown; never as zero.
      if (!isDatabasePermissionDenied(error)) throw error
      return { limit: limitView, currency, balanceMinor: null, pendingMinor: null, committedMinor: null, availableMinor: null, committedUnavailable: true, overdue: null, nearLimit: false, open: openView }
    }
    const committed = position.pendingMinor + (position.balanceMinor < 0n ? -position.balanceMinor : 0n)
    const available = position.availableMinor > 0n ? position.availableMinor : 0n
    const line = position.creditLineMinor
    return {
      limit: limitView, currency, balanceMinor: position.balanceMinor.toString(), pendingMinor: position.pendingMinor.toString(),
      committedMinor: committed.toString(), availableMinor: available.toString(),
      overdue: overdueView(aging), nearLimit: line > 0n && committed * 100n >= line * BigInt(AGENCY_CREDIT_NEAR_LIMIT_PERCENT), open: openView,
    }
  }

  async detail(tenantId: string, me: string, agencyId: string): Promise<AgencyView> {
    const agency = await this.suspension.detail(tenantId, me, agencyId)
    return { ...agency, credit: await this.credit(tenantId, me, agency.id) }
  }

  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<AgencyPage> { return this.suspension.list(tenantId, me, query) }

  async request(tenantId: string, userId: string, agencyId: string, body: AgencyCreditLimitRequest): Promise<AgencyView> {
    const agency = await this.suspension.detail(tenantId, userId, agencyId)
    const requestId = textParam('requestId', body?.requestId, 80)
    if (!requestId || requestId.length < 8) throw new BadRequestException('requestId is required (8 to 80 characters)')
    let proposed: Stored
    if (body?.limitMinor === null) proposed = { currency: null, limitMinor: null }
    else {
      if (typeof body?.limitMinor !== 'string' || !MINOR.test(body.limitMinor)) throw new BadRequestException('limitMinor must be a whole number of minor units (a string of digits) or null to remove the limit')
      if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) throw new BadRequestException('currency must be a 3-letter ISO-4217 code')
      proposed = { currency: body.currency, limitMinor: body.limitMinor }
    }
    const current = await this.prisma.withTenant(tenantId, (tx) => tx.agencyCreditLimit.findFirst({ where: { tenantId, agencyId: agency.id } }))
    const before: Stored = current ? { currency: current.currency, limitMinor: current.limitMinor.toString() } : { currency: null, limitMinor: null }
    if (before.currency === proposed.currency && before.limitMinor === proposed.limitMinor) throw new ConflictException('The agency already has this credit limit')
    const open = await this.openFor(tenantId, agency.id)
    if (open && open.requestId !== requestId) throw new ConflictException({ message: 'This agency already has an open credit limit request', code: 'AGENCY_CREDIT_REQUEST_OPEN' })
    await this.approvals.request({
      tenantId, requesterId: userId, action: CREDIT_LIMIT_APPROVAL_ACTION, entityType: CREDIT_ENTITY_TYPE, entityId: agency.id, requestId, reason: String(body.reason ?? ''),
      beforeState: before, proposedState: proposed,
    })
    return this.detail(tenantId, userId, agency.id)
  }

  private async own(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId).catch(() => { throw new NotFoundException('Credit limit request not found') })
    if (a.entityType !== CREDIT_ENTITY_TYPE || a.action !== CREDIT_LIMIT_APPROVAL_ACTION) throw new NotFoundException('Credit limit request not found')
    return a
  }

  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: AgencyCreditDecision): Promise<AgencyView> {
    const a = await this.own(tenantId, approvalId)
    await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.detail(tenantId, userId, a.entityId)
  }

  async cancel(tenantId: string, userId: string, approvalId: string): Promise<AgencyView> {
    const a = await this.own(tenantId, approvalId)
    await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    return this.detail(tenantId, userId, a.entityId)
  }

  /** Applies the approved limit once. The agency's limit must still be what it was when the request was made. */
  async execute(tenantId: string, userId: string, approvalId: string): Promise<AgencyCreditResult> {
    await this.own(tenantId, approvalId)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: CREDIT_LIMIT_APPROVAL_ACTION }, async (approval) => {
      const before = this.state(approval, 'beforeState'); const proposed = this.state(approval, 'proposedState')
      return this.prisma.withTenant(tenantId, async (tx) => {
        const agency = await tx.agency.findFirst({ where: { id: approval.entityId, tenantId }, select: { id: true } })
        if (!agency) throw new NotFoundException('Agency not found')
        const current = await tx.agencyCreditLimit.findFirst({ where: { tenantId, agencyId: agency.id } })
        const now: Stored = current ? { currency: current.currency, limitMinor: current.limitMinor.toString() } : { currency: null, limitMinor: null }
        if (now.currency !== before.currency || now.limitMinor !== before.limitMinor) throw new ConflictException({ message: 'The credit limit changed after this request was made. Make a new request.', code: 'AGENCY_CREDIT_CHANGED_AFTER_REQUEST' })
        if (proposed.limitMinor === null) await tx.agencyCreditLimit.deleteMany({ where: { tenantId, agencyId: agency.id } })
        else if (current) await tx.agencyCreditLimit.update({ where: { id: current.id }, data: { currency: proposed.currency!, limitMinor: BigInt(proposed.limitMinor), updatedById: userId } })
        else await tx.agencyCreditLimit.create({ data: { tenantId, agencyId: agency.id, currency: proposed.currency!, limitMinor: BigInt(proposed.limitMinor), updatedById: userId } })
        return { before, proposed }
      })
    })
    await this.audit.record({ tenantId, userId, action: 'agency.credit_limit.changed', entityType: 'agency', entityId: out.approval.entityId, payload: { approvalId, currency: out.result.proposed.currency, limitMinor: out.result.proposed.limitMinor, previousLimitMinor: out.result.before.limitMinor } })
    return { approval: this.approvalView(out.approval, userId), agency: await this.detail(tenantId, userId, out.approval.entityId) }
  }
}
