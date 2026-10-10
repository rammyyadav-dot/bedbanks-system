import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { HotelPublicationApproval, HotelPublicationDecision, HotelPublicationRequest, HotelPublicationResult } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { textParam } from '../admin-operations/query-params'
import { HotelSetupService } from './hotel-setup.service'
import { assessCompleteness } from './hotel-setup-rules'
import { lockHotelSetup } from './hotel-setup-shared'

export const HOTEL_PUBLISH_APPROVAL_ACTION = 'hotel.activate'
export const HOTEL_ENTITY_TYPE = 'hotel'
const STATUS_CHANGED = 'hotel.setup.status_changed'
const OPEN = new Set(['PENDING', 'APPROVED'])

/**
 * Publishing a hotel profile (contentStatus COMPLETE) goes through one single-use maker-checker approval (ADR 0022).
 * Requester and approver differ (ApprovalService), the request is bound to the exact setup version it was made against,
 * and applying it re-checks every publication requirement. Un-publishing stays a single-actor change.
 */
@Injectable()
export class HotelPublicationService {
  constructor(private readonly prisma: PrismaService, private readonly approvals: ApprovalService, private readonly setup: HotelSetupService) {}

  private view(a: ApprovalView, me: string, currentVersion: string | null): HotelPublicationApproval {
    const bound = this.boundVersion(a)
    return {
      id: a.id, status: a.status, reason: a.reason, requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason,
      canDecide: a.requestedById !== me && a.status === 'PENDING', canCancel: a.requestedById === me && a.status === 'PENDING', canExecute: a.status === 'APPROVED',
      changedSinceRequest: currentVersion !== null && bound !== currentVersion,
    }
  }

  private boundVersion(a: ApprovalView): string | undefined { return (a.beforeState as { setupVersion?: string } | null)?.setupVersion }

  /** An approved request for a version that has since changed can never be applied, so it no longer blocks a new request. */
  private async openRequest(tenantId: string, hotelId: string, currentVersion: string): Promise<ApprovalView | undefined> {
    return (await this.approvals.listForEntities(tenantId, HOTEL_ENTITY_TYPE, [hotelId]))
      .find((a) => a.action === HOTEL_PUBLISH_APPROVAL_ACTION && OPEN.has(a.status) && !(a.status === 'APPROVED' && this.boundVersion(a) !== currentVersion))
  }

  /** The open request for a hotel, as the caller sees it. */
  async open(tenantId: string, userId: string, hotelId: string, currentVersion: string): Promise<HotelPublicationApproval | null> {
    const a = await this.openRequest(tenantId, hotelId, currentVersion)
    return a ? this.view(a, userId, currentVersion) : null
  }

  private async state(tenantId: string, hotelId: string) {
    const data = await this.prisma.withTenant(tenantId, (tx) => this.setup.load(tx, tenantId, hotelId))
    return { data, version: this.setup.token(data.hotel, data.profile) }
  }

  private unmet(data: Awaited<ReturnType<HotelSetupService['load']>>): never | void {
    const c = assessCompleteness(this.setup.current(data.hotel, data.profile, data.activeRooms))
    if (!c.publishable) throw new UnprocessableEntityException({ message: `Cannot publish: ${c.requirements.filter((r) => !r.met).map((r) => r.label).join('; ')}.`, code: 'HOTEL_PUBLICATION_REQUIREMENTS_UNMET' })
  }

  async request(tenantId: string, userId: string, hotelId: string, body: HotelPublicationRequest): Promise<HotelPublicationResult> {
    const requestId = textParam('requestId', body?.requestId, 80)
    if (!requestId || requestId.length < 8) throw new BadRequestException('requestId is required (8 to 80 characters)')
    if (typeof body?.expectedToken !== 'string' || !body.expectedToken) throw new BadRequestException('expectedToken is required')
    const { data, version } = await this.state(tenantId, hotelId)
    if (body.expectedToken !== version) this.setup.stale()
    if (data.hotel.contentStatus === 'ARCHIVED') throw new ConflictException({ code: 'HOTEL_ARCHIVED', message: 'Restore the archived hotel to DRAFT before requesting publication.' })
    if (data.hotel.contentStatus === 'COMPLETE') throw new ConflictException('The hotel is already published')
    this.unmet(data)
    const open = await this.openRequest(tenantId, data.hotel.id, version)
    if (open && open.requestId !== requestId) throw new ConflictException({ message: 'This hotel already has an open publication request', code: 'HOTEL_PUBLICATION_REQUEST_OPEN' })
    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: HOTEL_PUBLISH_APPROVAL_ACTION, entityType: HOTEL_ENTITY_TYPE, entityId: data.hotel.id, requestId, reason: String(body.reason ?? ''),
      beforeState: { contentStatus: data.hotel.contentStatus, setupVersion: version }, proposedState: { contentStatus: 'COMPLETE' },
    })
    return { approval: this.view(approval, userId, version), setup: this.setup.toView(data, true) }
  }

  private async own(tenantId: string, hotelIdRaw: string, approvalId: string): Promise<{ approval: ApprovalView; hotelId: string }> {
    const { data } = await this.state(tenantId, hotelIdRaw)
    const approval = await this.approvals.get(tenantId, approvalId).catch(() => { throw new NotFoundException('Publication request not found') })
    if (approval.entityType !== HOTEL_ENTITY_TYPE || approval.action !== HOTEL_PUBLISH_APPROVAL_ACTION || approval.entityId !== data.hotel.id) throw new NotFoundException('Publication request not found')
    return { approval, hotelId: data.hotel.id }
  }

  private async result(tenantId: string, userId: string, hotelId: string, approval: ApprovalView): Promise<HotelPublicationResult> {
    const { data, version } = await this.state(tenantId, hotelId)
    return { approval: this.view(approval, userId, version), setup: this.setup.toView(data, true) }
  }

  async decide(tenantId: string, userId: string, hotelId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: HotelPublicationDecision): Promise<HotelPublicationResult> {
    const own = await this.own(tenantId, hotelId, approvalId)
    if (decision === 'APPROVED') {
      const { version } = await this.state(tenantId, own.hotelId)
      if (this.boundVersion(own.approval) !== version) throw new ConflictException({ message: 'The hotel changed after this request was made. Reject it and make a new request.', code: 'HOTEL_CHANGED_AFTER_REQUEST' })
    }
    const decided = await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    return this.result(tenantId, userId, own.hotelId, decided)
  }

  async cancel(tenantId: string, userId: string, hotelId: string, approvalId: string): Promise<HotelPublicationResult> {
    const own = await this.own(tenantId, hotelId, approvalId)
    return this.result(tenantId, userId, own.hotelId, await this.approvals.cancel({ tenantId, requesterId: userId, approvalId }))
  }

  /** Publishes once. Refused if the hotel changed after the request was made, or no longer meets a requirement. */
  async execute(tenantId: string, userId: string, hotelId: string, approvalId: string, requestId: string | null): Promise<HotelPublicationResult> {
    const own = await this.own(tenantId, hotelId, approvalId)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: HOTEL_PUBLISH_APPROVAL_ACTION }, async (approval) => {
      const bound = this.boundVersion(approval)
      return this.prisma.withTenant(tenantId, async (tx) => {
        // Share Setup's lock before loading: an edit reviewed while still DRAFT must
        // finish before publication rechecks its version and completeness.
        await lockHotelSetup(tx, tenantId, own.hotelId)
        const before = await this.setup.load(tx, tenantId, own.hotelId)
        if (this.setup.token(before.hotel, before.profile) !== bound) throw new ConflictException({ message: 'The hotel changed after this request was approved. Make a new publication request.', code: 'HOTEL_CHANGED_AFTER_APPROVAL' })
        if (before.hotel.contentStatus === 'COMPLETE') throw new ConflictException('The hotel is already published')
        this.unmet(before)
        const now = new Date()
        const moved = await tx.hotel.updateMany({ where: { id: before.hotel.id, tenantId, updatedAt: before.hotel.updatedAt }, data: { contentStatus: 'COMPLETE', updatedAt: now } })
        if (moved.count !== 1) this.setup.stale()
        // The approver is the checker of record: approvedById names who decided, not who pressed apply.
        const stamp = { approvedById: approval.decidedById, approvedAt: now, updatedById: userId, version: { increment: 1 } }
        if (before.profile) await tx.hotelProfile.update({ where: { id: before.profile.id }, data: stamp })
        else await tx.hotelProfile.create({ data: { tenantId, hotelId: before.hotel.id, approvedById: approval.decidedById, approvedAt: now, updatedById: userId, version: 1 } })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: STATUS_CHANGED, entityType: 'hotel', entityId: before.hotel.id, payload: { outcome: 'allowed', requestId, approvalId, approvedById: approval.decidedById, from: before.hotel.contentStatus, to: 'COMPLETE', fromVersion: before.profile?.version ?? 0, toVersion: (before.profile?.version ?? 0) + 1 } as Prisma.InputJsonValue } })
      })
    })
    return this.result(tenantId, userId, own.hotelId, out.approval)
  }
}
