import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma, RoomEvent } from '@prisma/client'
import type { RoomEventRead, RoomEventTransitionInput, RoomEventType, RoomEventUpdate, RoomEventWrite } from '@bedbanks/contracts'
import { ROOM_EVENT_STATUSES, ROOM_EVENT_TYPES } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { dayParam, enumParam, textParam, idParam, pageParams, paged } from '../admin-operations/query-params'

/** The permission-catalogue key (S3, approval-only, refines supply.room_events.manage). */
export const ROOM_EVENT_APPROVAL_ACTION = 'room_event.approve'
const ENTITY_TYPE = 'room_event'
const OPEN = new Set(['PENDING', 'APPROVED'])
const day = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * Room Event Master (ADR 0089): the event catalogue, independent of any hotel's commercial terms. DRAFT is freely editable; submitting
 * moves it to PENDING_APPROVAL behind a maker-checker request (ADR 0016) so the submitter cannot also approve their own event (segregation
 * of duties, enforced generically by ApprovalService.decide). CANCELLED and ARCHIVED are terminal: no new EventSupplement may reference
 * a RoomEvent that is not APPROVED (enforced in EventSupplementsService).
 */
@Injectable()
export class RoomEventsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService) {}

  private view(r: RoomEvent): RoomEventRead {
    return {
      id: r.id, tenantId: r.tenantId, name: r.name, eventType: r.eventType as RoomEventType, destinationCity: r.destinationCity, destinationCountry: r.destinationCountry,
      eventStartDate: day(r.eventStartDate), eventEndDate: day(r.eventEndDate), status: r.status, referenceRef: r.referenceRef, internalNotes: r.internalNotes,
      createdById: r.createdById, approvedById: r.approvedById, approvedAt: r.approvedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    }
  }

  private async row(tenantId: string, roomEventId: string): Promise<RoomEvent> {
    const id = idParam('roomEventId', roomEventId)
    if (!id) throw new BadRequestException('Invalid roomEventId')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.findFirst({ where: { id, tenantId } }))
    if (!row) throw new NotFoundException('Room event not found')
    return row
  }

  private validate(body: Partial<RoomEventWrite>, errors: string[]): void {
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 160)) errors.push('name: 1 to 160 characters')
    if (body.eventType !== undefined && !(ROOM_EVENT_TYPES as readonly string[]).includes(body.eventType)) errors.push(`eventType: one of ${ROOM_EVENT_TYPES.join(', ')}`)
    if (body.destinationCity !== undefined && (typeof body.destinationCity !== 'string' || body.destinationCity.trim().length < 1 || body.destinationCity.length > 120)) errors.push('destinationCity: 1 to 120 characters')
    if (body.destinationCountry !== undefined && (typeof body.destinationCountry !== 'string' || !/^[A-Z]{2}$/.test(body.destinationCountry.toUpperCase()))) errors.push('destinationCountry: a 2-letter ISO-3166 code')
  }

  async list(tenantId: string, query: Record<string, unknown>) {
    const page = pageParams(query)
    const status = enumParam('status', query.status, ROOM_EVENT_STATUSES)
    const destinationCity = textParam('destinationCity', query.destinationCity, 120)
    const where: Prisma.RoomEventWhereInput = { tenantId, ...(status && { status }), ...(destinationCity && { destinationCity }) }
    const [rows, total] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.roomEvent.findMany({ where, orderBy: [{ eventStartDate: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take }),
      tx.roomEvent.count({ where }),
    ]))
    return paged(rows.map((r) => this.view(r)), page, total)
  }

  async get(tenantId: string, roomEventId: string): Promise<RoomEventRead> { return this.view(await this.row(tenantId, roomEventId)) }

  async create(tenantId: string, userId: string, body: RoomEventWrite): Promise<RoomEventRead> {
    const errors: string[] = []
    this.validate(body, errors)
    if (body.name === undefined || body.eventType === undefined || body.destinationCity === undefined || body.destinationCountry === undefined) errors.push('name, eventType, destinationCity and destinationCountry are required')
    const eventStartDate = dayParam('eventStartDate', body.eventStartDate)
    const eventEndDate = dayParam('eventEndDate', body.eventEndDate)
    if (!eventStartDate || !eventEndDate) errors.push('eventStartDate and eventEndDate are required calendar days')
    else if (eventEndDate < eventStartDate) errors.push('eventEndDate must be on or after eventStartDate')
    const referenceRef = textParam('referenceRef', body.referenceRef ?? undefined, 200)
    const internalNotes = typeof body.internalNotes === 'string' ? body.internalNotes.slice(0, 4000) : undefined
    if (errors.length) throw new BadRequestException(errors.join('; '))
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.create({
      data: { tenantId, name: body.name.trim(), eventType: body.eventType, destinationCity: body.destinationCity.trim(), destinationCountry: body.destinationCountry.toUpperCase(), eventStartDate: eventStartDate!, eventEndDate: eventEndDate!, referenceRef: referenceRef ?? null, internalNotes: internalNotes ?? null, createdById: userId },
    }))
    await this.audit.record({ tenantId, userId, action: 'room_event.created', entityType: ENTITY_TYPE, entityId: row.id, payload: { name: row.name, destinationCity: row.destinationCity, eventStartDate: day(row.eventStartDate), eventEndDate: day(row.eventEndDate) } })
    return this.view(row)
  }

  async update(tenantId: string, userId: string, roomEventId: string, body: RoomEventUpdate): Promise<RoomEventRead> {
    const current = await this.row(tenantId, roomEventId)
    if (current.status !== 'DRAFT') throw new ConflictException('Only a draft event can be edited')
    const errors: string[] = []
    this.validate(body, errors)
    const eventStartDate = body.eventStartDate !== undefined ? dayParam('eventStartDate', body.eventStartDate) : current.eventStartDate
    const eventEndDate = body.eventEndDate !== undefined ? dayParam('eventEndDate', body.eventEndDate) : current.eventEndDate
    if (body.eventStartDate !== undefined && !eventStartDate) errors.push('eventStartDate: a real calendar day')
    if (body.eventEndDate !== undefined && !eventEndDate) errors.push('eventEndDate: a real calendar day')
    if (eventStartDate && eventEndDate && eventEndDate < eventStartDate) errors.push('eventEndDate must be on or after eventStartDate')
    if (errors.length) throw new BadRequestException(errors.join('; '))
    const data: Prisma.RoomEventUpdateInput = {}
    if (body.name !== undefined) data.name = body.name.trim()
    if (body.eventType !== undefined) data.eventType = body.eventType
    if (body.destinationCity !== undefined) data.destinationCity = body.destinationCity.trim()
    if (body.destinationCountry !== undefined) data.destinationCountry = body.destinationCountry.toUpperCase()
    if (body.eventStartDate !== undefined) data.eventStartDate = eventStartDate!
    if (body.eventEndDate !== undefined) data.eventEndDate = eventEndDate!
    if (body.referenceRef !== undefined) data.referenceRef = body.referenceRef
    if (body.internalNotes !== undefined) data.internalNotes = body.internalNotes
    const updated = await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.updateMany({ where: { id: current.id, tenantId, status: 'DRAFT' }, data }))
    if (updated.count !== 1) throw new ConflictException('Only a draft event can be edited')
    const row = await this.row(tenantId, roomEventId)
    await this.audit.record({ tenantId, userId, action: 'room_event.updated', entityType: ENTITY_TYPE, entityId: row.id, payload: { fields: Object.keys(body) } })
    return this.view(row)
  }

  private approvalView(a: ApprovalView | undefined, me: string) {
    if (!a) return null
    return { id: a.id, status: a.status, requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason, canDecide: a.requestedById !== me && a.status === 'PENDING', canCancel: a.requestedById === me && a.status === 'PENDING', canExecute: a.status === 'APPROVED' }
  }

  /** DRAFT -> PENDING_APPROVAL: opens a maker-checker request. The DB row moves immediately; the request only records who reviews it. */
  async submit(tenantId: string, userId: string, roomEventId: string, body: RoomEventTransitionInput, requestId?: string) {
    const current = await this.row(tenantId, roomEventId)
    if (current.status !== 'DRAFT') throw new ConflictException('Only a draft event can be submitted')
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    const key = requestId ?? `${current.id}:submit:${current.updatedAt.toISOString()}`
    const approval = await this.approvals.request({
      tenantId, requesterId: userId, action: ROOM_EVENT_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: current.id, requestId: key, reason,
      proposedState: { name: current.name, destinationCity: current.destinationCity, eventStartDate: day(current.eventStartDate), eventEndDate: day(current.eventEndDate) },
    })
    const moved = await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.updateMany({ where: { id: current.id, tenantId, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } }))
    if (moved.count !== 1 && current.status !== 'PENDING_APPROVAL') throw new ConflictException('Only a draft event can be submitted')
    await this.audit.record({ tenantId, userId, action: 'room_event.submitted', entityType: ENTITY_TYPE, entityId: current.id, payload: { approvalId: approval.id } })
    return { ...this.view(await this.row(tenantId, roomEventId)), approval: this.approvalView(approval, userId) }
  }

  private async assertApproval(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId)
    if (a.entityType !== ENTITY_TYPE || a.action !== ROOM_EVENT_APPROVAL_ACTION) throw new BadRequestException('Not a room event approval')
    return a
  }

  /** APPROVED decision moves the event to APPROVED and stamps approvedById/approvedAt; REJECTED returns it to DRAFT for correction. */
  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: { reason: string }) {
    const a = await this.assertApproval(tenantId, approvalId)
    const updated = await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    const approvedAt = new Date()
    if (updated.status === 'APPROVED') {
      await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.updateMany({ where: { id: a.entityId, tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED', approvedById: userId, approvedAt } }))
      await this.audit.record({ tenantId, userId, action: 'room_event.approved', entityType: ENTITY_TYPE, entityId: a.entityId, payload: { approvalId } })
    } else if (updated.status === 'REJECTED') {
      await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.updateMany({ where: { id: a.entityId, tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } }))
      await this.audit.record({ tenantId, userId, action: 'room_event.rejected', entityType: ENTITY_TYPE, entityId: a.entityId, payload: { approvalId, reason: body?.reason } })
    }
    return { ...this.view(await this.row(tenantId, a.entityId)), approval: this.approvalView(updated, userId) }
  }

  async cancelApproval(tenantId: string, userId: string, approvalId: string) {
    const a = await this.assertApproval(tenantId, approvalId)
    const updated = await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    if (updated.status === 'CANCELLED') await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.updateMany({ where: { id: a.entityId, tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } }))
    return { ...this.view(await this.row(tenantId, a.entityId)), approval: this.approvalView(updated, userId) }
  }

  /** Single-actor terminal moves (no approval needed to stop future use; reason required and audited, mirroring Contract.suspend, ADR 0067 F-01). */
  async cancel(tenantId: string, userId: string, roomEventId: string, body: RoomEventTransitionInput): Promise<RoomEventRead> {
    const current = await this.row(tenantId, roomEventId)
    if (current.status === 'CANCELLED' || current.status === 'ARCHIVED') throw new ConflictException(`Event is already ${current.status.toLowerCase()}`)
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.update({ where: { id: current.id, tenantId }, data: { status: 'CANCELLED' } }))
    await this.audit.record({ tenantId, userId, action: 'room_event.cancelled', entityType: ENTITY_TYPE, entityId: current.id, payload: { from: current.status, reason } })
    return this.view(await this.row(tenantId, roomEventId))
  }

  async archive(tenantId: string, userId: string, roomEventId: string, body: RoomEventTransitionInput): Promise<RoomEventRead> {
    const current = await this.row(tenantId, roomEventId)
    if (current.status !== 'APPROVED' && current.status !== 'CANCELLED') throw new ConflictException('Only an approved or cancelled event can be archived')
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    // The database requires approvedById on an ARCHIVED row; a never-approved (DRAFT -> CANCELLED) event is attributed to whoever archives it.
    await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.update({ where: { id: current.id, tenantId }, data: { status: 'ARCHIVED', approvedById: current.approvedById ?? userId, approvedAt: current.approvedAt ?? new Date() } }))
    await this.audit.record({ tenantId, userId, action: 'room_event.archived', entityType: ENTITY_TYPE, entityId: current.id, payload: { from: current.status, reason } })
    return this.view(await this.row(tenantId, roomEventId))
  }
}
