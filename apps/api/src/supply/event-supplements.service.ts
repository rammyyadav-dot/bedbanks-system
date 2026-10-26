import { createHash } from 'node:crypto'
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { EventSupplement, Prisma, SupplementBasis, SupplementFrequency } from '@prisma/client'
import { EVENT_SUPPLEMENT_STATUSES, type EventSupplementActivationRequestInput, type EventSupplementAmountKind, type EventSupplementApprovalDecisionInput, type EventSupplementPreviewRequest, type EventSupplementPreviewResult, type EventSupplementRead, type EventSupplementStatus, type EventSupplementSuspendInput, type EventSupplementTaxTreatment, type EventSupplementWrite } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService, type ApprovalView } from '../approvals/approval.service'
import { dayParam, enumParam, textParam, idParam, pageParams, paged } from '../admin-operations/query-params'
import { eventSupplementNights, eventSupplementsForPlan } from './event-supplements'

/** The permission-catalogue key (S3, approval-only, refines supply.event_supplements.manage). */
export const EVENT_SUPPLEMENT_APPROVAL_ACTION = 'event_supplement.approve'
const ENTITY_TYPE = 'event_supplement'
const CURRENCY = /^[A-Z]{3}$/
const day = (d: Date): string => d.toISOString().slice(0, 10)

/** The reviewed terms a fingerprint is taken over: everything that can change the price. */
interface SupplementTerms {
  roomEventId: string; contractId: string; ratePlanId: string | null
  amountKind: EventSupplementAmountKind; basis: string | null; frequency: string | null; amountMinor: string | null; percentBp: number | null
  currency: string; taxTreatment: EventSupplementTaxTreatment; validFrom: string; validTo: string; stackable: boolean; priority: number; evidenceRef: string
}
function fingerprint(terms: SupplementTerms): string {
  const unordered = terms as unknown as Record<string, unknown>
  const ordered = Object.keys(unordered).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = unordered[k]; return acc }, {})
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}
const termsOf = (r: EventSupplement): SupplementTerms => ({
  roomEventId: r.roomEventId, contractId: r.contractId, ratePlanId: r.ratePlanId, amountKind: r.amountKind as EventSupplementAmountKind,
  basis: r.basis, frequency: r.frequency, amountMinor: r.amountMinor?.toString() ?? null, percentBp: r.percentBp,
  currency: r.currency, taxTreatment: r.taxTreatment as EventSupplementTaxTreatment, validFrom: day(r.validFrom), validTo: day(r.validTo), stackable: r.stackable, priority: r.priority, evidenceRef: r.evidenceRef,
})

/**
 * Event and exhibition supplements (ADR 0089): a commercial rule linking an approved RoomEvent to one contract (and optionally one rate
 * plan). Lifecycle: DRAFT (freely editable) -> submit -> PENDING_APPROVAL (maker-checker, ADR 0016; a submitter cannot decide their own
 * request) -> APPROVED -> activate (writes an immutable EventSupplementVersion snapshot, ADR 0067 F-01's pattern) -> ACTIVE, or ACTIVE ->
 * suspend (single-actor, reason required, like Contract.suspend) -> SUSPENDED. Only ACTIVE rows with an APPROVED RoomEvent are ever priced
 * (assess-plan-select.ts); nothing here ever writes DailyRate.
 */
@Injectable()
export class EventSupplementsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService, private readonly approvals: ApprovalService) {}

  private view(r: EventSupplement): EventSupplementRead {
    return {
      id: r.id, tenantId: r.tenantId, roomEventId: r.roomEventId, contractId: r.contractId, ratePlanId: r.ratePlanId,
      amountKind: r.amountKind as EventSupplementAmountKind, basis: r.basis, frequency: r.frequency, amountMinor: r.amountMinor?.toString() ?? null, percentBp: r.percentBp,
      currency: r.currency, taxTreatment: r.taxTreatment as EventSupplementTaxTreatment, validFrom: day(r.validFrom), validTo: day(r.validTo),
      stackable: r.stackable, priority: r.priority, evidenceRef: r.evidenceRef, status: r.status as EventSupplementStatus, version: r.version,
      createdById: r.createdById, approvedById: r.approvedById, activatedAt: r.activatedAt?.toISOString() ?? null, suspendedAt: r.suspendedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    }
  }

  private async row(tenantId: string, id: string): Promise<EventSupplement> {
    const eventSupplementId = idParam('eventSupplementId', id)
    if (!eventSupplementId) throw new BadRequestException('Invalid eventSupplementId')
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.eventSupplement.findFirst({ where: { id: eventSupplementId, tenantId } }))
    if (!row) throw new NotFoundException('Event supplement not found')
    return row
  }

  /** The commercial-terms shape: the same rule the database CHECK constraint enforces. Shared by create and amendment validation —
   * an amendment never changes which event, contract or rate plan the supplement is bound to, only these terms. Dates come back as
   * YYYY-MM-DD strings (the `SupplementTerms` shape); a caller writing to Prisma converts them back to `Date`. */
  private validateTerms(body: Record<string, unknown>, errors: string[]) {
    const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
    if (!CURRENCY.test(currency)) errors.push('currency: a 3-letter ISO-4217 code')
    const validFromDate = dayParam('validFrom', body.validFrom)
    const validToDate = dayParam('validTo', body.validTo)
    if (!validFromDate || !validToDate) errors.push('validFrom and validTo are required calendar days')
    else if (validToDate < validFromDate) errors.push('validTo must be on or after validFrom')
    const evidenceRef = textParam('evidenceRef', body.evidenceRef, 200)
    if (!evidenceRef) errors.push('evidenceRef is required: a supplier confirmation or authorized contract amendment reference')
    const priority = typeof body.priority === 'number' ? body.priority : 0
    if (!Number.isSafeInteger(priority)) errors.push('priority must be an integer')
    if (body.amountKind === 'FIXED') {
      if (!['PER_ADULT', 'PER_CHILD', 'PER_PERSON', 'PER_ROOM'].includes(body.basis as string)) errors.push('basis: one of PER_ADULT, PER_CHILD, PER_PERSON, PER_ROOM')
      if (!['PER_NIGHT', 'PER_STAY'].includes(body.frequency as string)) errors.push('frequency: PER_NIGHT or PER_STAY')
      if (!/^[1-9][0-9]{0,15}$/.test((body.amountMinor as string) ?? '')) errors.push('amountMinor: a positive whole number of minor units')
    } else if (body.amountKind === 'PERCENTAGE') {
      const percentBp = body.percentBp
      if (!Number.isSafeInteger(percentBp) || (percentBp as number) <= 0 || (percentBp as number) > 10_000) errors.push('percentBp: an integer from 1 to 10000')
    } else {
      errors.push('amountKind: FIXED or PERCENTAGE')
    }
    return { currency, validFrom: validFromDate ? day(validFromDate) : undefined, validTo: validToDate ? day(validToDate) : undefined, evidenceRef, priority }
  }

  /** Validates the cross-entity scope on top of `validateTerms`, for creation only. */
  private async validateCreate(tenantId: string, body: EventSupplementWrite, errors: string[]) {
    const roomEventId = idParam('roomEventId', body.roomEventId)
    const contractId = idParam('contractId', body.contractId)
    const ratePlanId = body.ratePlanId ? idParam('ratePlanId', body.ratePlanId) : null
    if (!roomEventId) errors.push('roomEventId is required')
    if (!contractId) errors.push('contractId is required')
    let roomEvent: { status: string } | null = null
    let contract: { id: string; tenantId: string } | null = null
    let ratePlan: { contractId: string } | null = null
    if (roomEventId) roomEvent = await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.findFirst({ where: { id: roomEventId, tenantId }, select: { status: true } }))
    if (!roomEvent) errors.push('roomEventId does not name a room event of this tenant')
    else if (roomEvent.status !== 'APPROVED') errors.push('roomEventId must name an APPROVED room event (never attach commercial terms to an unapproved event)')
    if (contractId) contract = await this.prisma.withTenant(tenantId, (tx) => tx.contract.findFirst({ where: { id: contractId, tenantId }, select: { id: true, tenantId: true } }))
    if (!contract) errors.push('contractId does not name a contract of this tenant')
    if (ratePlanId) {
      ratePlan = await this.prisma.withTenant(tenantId, (tx) => tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { contractId: true } }))
      if (!ratePlan) errors.push('ratePlanId does not name a rate plan of this tenant')
      else if (contractId && ratePlan.contractId !== contractId) errors.push('ratePlanId must belong to contractId')
    }
    const terms = this.validateTerms(body as unknown as Record<string, unknown>, errors)
    return { roomEventId, contractId, ratePlanId, ...terms }
  }

  async list(tenantId: string, userId: string, query: Record<string, unknown>) {
    const page = pageParams(query)
    const status = enumParam('status', query.status, EVENT_SUPPLEMENT_STATUSES)
    const roomEventId = idParam('roomEventId', query.roomEventId)
    const contractId = idParam('contractId', query.contractId)
    const where: Prisma.EventSupplementWhereInput = { tenantId, ...(status && { status }), ...(roomEventId && { roomEventId }), ...(contractId && { contractId }) }
    const [rows, total] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.eventSupplement.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
      tx.eventSupplement.count({ where }),
    ]))
    const latest = await this.latestApprovals(tenantId, rows.map((r) => r.id))
    return paged(rows.map((r) => ({ ...this.view(r), approval: this.approvalView(latest.get(r.id), userId) })), page, total)
  }

  async get(tenantId: string, userId: string, id: string) {
    const row = await this.row(tenantId, id)
    const latest = await this.latestApprovals(tenantId, [row.id])
    return { ...this.view(row), approval: this.approvalView(latest.get(row.id), userId) }
  }

  /** The most recent approval request per entity (open or decided), for a list/detail view to show without a second round trip. */
  private async latestApprovals(tenantId: string, ids: string[]): Promise<Map<string, ApprovalView>> {
    const latest = new Map<string, ApprovalView>()
    for (const a of await this.approvals.listForEntities(tenantId, ENTITY_TYPE, ids)) if (!latest.has(a.entityId)) latest.set(a.entityId, a)
    return latest
  }

  async create(tenantId: string, userId: string, body: EventSupplementWrite): Promise<EventSupplementRead> {
    const errors: string[] = []
    const scoped = await this.validateCreate(tenantId, body, errors)
    if (errors.length) throw new BadRequestException(errors.join('; '))
    const row = await this.prisma.withTenant(tenantId, (tx) => tx.eventSupplement.create({
      data: {
        tenantId, roomEventId: scoped.roomEventId!, contractId: scoped.contractId!, ratePlanId: scoped.ratePlanId,
        amountKind: body.amountKind, basis: body.amountKind === 'FIXED' ? body.basis : null, frequency: body.amountKind === 'FIXED' ? body.frequency : null,
        amountMinor: body.amountKind === 'FIXED' ? BigInt(body.amountMinor) : null, percentBp: body.amountKind === 'PERCENTAGE' ? body.percentBp : null,
        currency: scoped.currency, taxTreatment: body.taxTreatment ?? 'EXCLUSIVE', validFrom: new Date(`${scoped.validFrom}T00:00:00.000Z`), validTo: new Date(`${scoped.validTo}T00:00:00.000Z`),
        stackable: body.stackable ?? false, priority: scoped.priority, evidenceRef: scoped.evidenceRef!, createdById: userId,
      },
    }))
    await this.audit.record({ tenantId, userId, action: 'event_supplement.created', entityType: ENTITY_TYPE, entityId: row.id, payload: { roomEventId: row.roomEventId, contractId: row.contractId, ratePlanId: row.ratePlanId, amountKind: row.amountKind } })
    return this.view(row)
  }

  private approvalView(a: ApprovalView | undefined, me: string) {
    if (!a) return null
    return { id: a.id, status: a.status, requestedById: a.requestedById, decidedById: a.decidedById, decisionReason: a.decisionReason, canDecide: a.requestedById !== me && a.status === 'PENDING', canCancel: a.requestedById === me && a.status === 'PENDING', canExecute: a.status === 'APPROVED' }
  }

  async submit(tenantId: string, userId: string, id: string, body: EventSupplementActivationRequestInput) {
    const current = await this.row(tenantId, id)
    if (current.status !== 'DRAFT') throw new ConflictException('Only a draft supplement can be submitted')
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    const key = body?.requestId ?? `${current.id}:submit:${current.updatedAt.toISOString()}`
    const terms = termsOf(current)
    const approval = await this.approvals.request({ tenantId, requesterId: userId, action: EVENT_SUPPLEMENT_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: current.id, requestId: key, reason, proposedState: { kind: 'ACTIVATION', fingerprint: fingerprint(terms), ...terms } })
    const moved = await this.prisma.withTenant(tenantId, (tx) => tx.eventSupplement.updateMany({ where: { id: current.id, tenantId, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL' } }))
    if (moved.count !== 1) throw new ConflictException('Only a draft supplement can be submitted')
    await this.audit.record({ tenantId, userId, action: 'event_supplement.submitted', entityType: ENTITY_TYPE, entityId: current.id, payload: { approvalId: approval.id } })
    return { ...this.view(await this.row(tenantId, id)), approval: this.approvalView(approval, userId) }
  }

  private async assertApproval(tenantId: string, approvalId: string): Promise<ApprovalView> {
    const a = await this.approvals.get(tenantId, approvalId)
    if (a.entityType !== ENTITY_TYPE || a.action !== EVENT_SUPPLEMENT_APPROVAL_ACTION) throw new BadRequestException('Not an event supplement approval')
    return a
  }

  /** ACTIVATION (the default, for approvals filed before this field existed) or AMENDMENT — bound at request time, never guessed. */
  private boundKind(a: ApprovalView): 'ACTIVATION' | 'AMENDMENT' {
    return (a.proposedState as { kind?: string } | null)?.kind === 'AMENDMENT' ? 'AMENDMENT' : 'ACTIVATION'
  }

  /**
   * Decides a request. An ACTIVATION decision moves the row itself (APPROVED, or back to DRAFT on rejection); an AMENDMENT decision only
   * records the decision — the amendment is applied, and the version written, only by `execute` (the terms must not change until a
   * second person has reviewed exactly what `execute` will apply, same as a contract amendment, ADR 0067 F-01).
   */
  async decide(tenantId: string, userId: string, approvalId: string, decision: 'APPROVED' | 'REJECTED', body: EventSupplementApprovalDecisionInput) {
    const a = await this.assertApproval(tenantId, approvalId)
    const updated = await this.approvals.decide({ tenantId, approverId: userId, approvalId, decision, reason: String(body?.reason ?? '') })
    if (this.boundKind(a) === 'ACTIVATION') {
      if (updated.status === 'APPROVED') {
        await this.prisma.withTenant(tenantId, (tx) => tx.eventSupplement.updateMany({ where: { id: a.entityId, tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'APPROVED', approvedById: userId } }))
        await this.audit.record({ tenantId, userId, action: 'event_supplement.approved', entityType: ENTITY_TYPE, entityId: a.entityId, payload: { approvalId } })
      } else if (updated.status === 'REJECTED') {
        await this.prisma.withTenant(tenantId, (tx) => tx.eventSupplement.updateMany({ where: { id: a.entityId, tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } }))
        await this.audit.record({ tenantId, userId, action: 'event_supplement.rejected', entityType: ENTITY_TYPE, entityId: a.entityId, payload: { approvalId, reason: body?.reason } })
      }
    } else if (updated.status === 'APPROVED') {
      await this.audit.record({ tenantId, userId, action: 'event_supplement.amendment_approved', entityType: ENTITY_TYPE, entityId: a.entityId, payload: { approvalId } })
    } else if (updated.status === 'REJECTED') {
      await this.audit.record({ tenantId, userId, action: 'event_supplement.amendment_rejected', entityType: ENTITY_TYPE, entityId: a.entityId, payload: { approvalId, reason: body?.reason } })
    }
    return { ...this.view(await this.row(tenantId, a.entityId)), approval: this.approvalView(updated, userId) }
  }

  async cancelApproval(tenantId: string, userId: string, approvalId: string) {
    const a = await this.assertApproval(tenantId, approvalId)
    const updated = await this.approvals.cancel({ tenantId, requesterId: userId, approvalId })
    if (updated.status === 'CANCELLED') await this.prisma.withTenant(tenantId, (tx) => tx.eventSupplement.updateMany({ where: { id: a.entityId, tenantId, status: 'PENDING_APPROVAL' }, data: { status: 'DRAFT' } }))
    return { ...this.view(await this.row(tenantId, a.entityId)), approval: this.approvalView(updated, userId) }
  }

  /**
   * Activates an APPROVED supplement: re-validates that its RoomEvent is still APPROVED (never activate against a since-cancelled event),
   * appends an immutable EventSupplementVersion snapshot (ADR 0067 F-01's pattern; `requestedById <> approvedById` is already guaranteed by
   * ApprovalService's self-approval refusal), and moves the row to ACTIVE. Nothing here writes DailyRate. The ACTIVATION approval itself
   * is claimed through `ApprovalService.execute` (APPROVED -> EXECUTED, single use) so it can never be read back as "open" by a later
   * amendment request on the same supplement.
   */
  async activate(tenantId: string, userId: string, id: string, body: { reason: string }): Promise<EventSupplementRead> {
    const current = await this.row(tenantId, id)
    if (current.status !== 'APPROVED') throw new ConflictException('Only an approved supplement can be activated')
    if (!current.approvedById) throw new ConflictException('The supplement has no recorded approver')
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    const approvals = await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [current.id])
    const approved = approvals.find((a) => a.action === EVENT_SUPPLEMENT_APPROVAL_ACTION && this.boundKind(a) === 'ACTIVATION' && a.status === 'APPROVED')
    if (!approved) throw new ConflictException('No approved activation request found for this supplement')
    const roomEvent = await this.prisma.withTenant(tenantId, (tx) => tx.roomEvent.findFirst({ where: { id: current.roomEventId, tenantId }, select: { status: true } }))
    if (!roomEvent || roomEvent.status !== 'APPROVED') throw new ConflictException('The room event is no longer approved')
    const terms = termsOf(current)
    const print = fingerprint(terms)
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId: approved.id, expectedAction: EVENT_SUPPLEMENT_APPROVAL_ACTION }, async (approval) => {
      const now = new Date()
      return this.prisma.withTenant(tenantId, async (tx) => {
        const updated = await tx.eventSupplement.updateMany({ where: { id: current.id, tenantId, status: 'APPROVED' }, data: { status: 'ACTIVE', activatedAt: now } })
        if (updated.count !== 1) throw new ConflictException('Only an approved supplement can be activated')
        await tx.eventSupplementVersion.create({ data: { tenantId, eventSupplementId: current.id, version: current.version, kind: 'ACTIVATION', terms: terms as unknown as Prisma.InputJsonValue, fingerprint: print, approvalId: approval.id, requestedById: approval.requestedById, approvedById: current.approvedById!, appliedById: userId, reason } })
        const row = await tx.eventSupplement.findFirst({ where: { id: current.id, tenantId } })
        if (!row) throw new NotFoundException('Event supplement not found')
        return row
      })
    })
    await this.audit.record({ tenantId, userId, action: 'event_supplement.activated', entityType: ENTITY_TYPE, entityId: current.id, payload: { roomEventId: current.roomEventId, contractId: current.contractId, fingerprint: print } })
    return this.view(out.result)
  }

  /**
   * Files a maker-checker request to change the commercial terms of an already-ACTIVE or SUSPENDED supplement (never which event,
   * contract or rate plan it is bound to — that never changes). Nothing is written yet; `execute` applies it once approved, re-validating
   * against the terms as they stand then (ADR 0067 F-01's amendment pattern).
   */
  async requestAmendment(tenantId: string, userId: string, id: string, body: { changes?: Record<string, unknown>; reason: string; requestId?: string }) {
    const current = await this.row(tenantId, id)
    if (current.status !== 'ACTIVE' && current.status !== 'SUSPENDED') throw new ConflictException('Only an active or suspended supplement can be amended')
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    const changes = (body?.changes && typeof body.changes === 'object' ? body.changes : {}) as Record<string, unknown>
    const errors: string[] = []
    const merged = this.mergedTerms(termsOf(current), changes, errors)
    if (errors.length) throw new BadRequestException(errors.join('; '))
    const print = fingerprint(merged)
    if (print === fingerprint(termsOf(current))) throw new BadRequestException('The amendment changes nothing')
    const open = (await this.approvals.listForEntities(tenantId, ENTITY_TYPE, [current.id])).find((a) => a.status === 'PENDING' || a.status === 'APPROVED')
    if (open) throw new ConflictException('This supplement already has an open request')
    const key = body?.requestId ?? `${current.id}:amend:${current.updatedAt.toISOString()}`
    const approval = await this.approvals.request({ tenantId, requesterId: userId, action: EVENT_SUPPLEMENT_APPROVAL_ACTION, entityType: ENTITY_TYPE, entityId: current.id, requestId: key, reason, proposedState: { kind: 'AMENDMENT', fingerprint: print, changes, ...merged } })
    await this.audit.record({ tenantId, userId, action: 'event_supplement.amendment_requested', entityType: ENTITY_TYPE, entityId: current.id, payload: { approvalId: approval.id } })
    return { ...this.view(current), approval: this.approvalView(approval, userId) }
  }

  /** Merges amendable fields onto the current terms, validating the result as a whole (so a partial change can't produce an invalid shape, e.g. changing only percentBp on a FIXED row). */
  private mergedTerms(current: SupplementTerms, changes: Record<string, unknown>, errors: string[]): SupplementTerms {
    const candidate: Record<string, unknown> = { ...current }
    for (const key of ['amountKind', 'basis', 'frequency', 'amountMinor', 'percentBp', 'currency', 'taxTreatment', 'validFrom', 'validTo', 'stackable', 'priority', 'evidenceRef'] as const) {
      if (changes[key] !== undefined) candidate[key] = changes[key]
    }
    // Switching amountKind must clear the other shape's fields, exactly as a fresh create would (never a stale basis next to a percentBp).
    if (changes.amountKind === 'FIXED') { candidate.percentBp = null }
    else if (changes.amountKind === 'PERCENTAGE') { candidate.basis = null; candidate.frequency = null; candidate.amountMinor = null }
    const terms = this.validateTerms(candidate, errors)
    return { ...current, ...candidate, ...terms } as SupplementTerms
  }

  /** Applies an approved AMENDMENT: re-validates against the terms as they stand now, writes an immutable AMENDMENT version, and bumps
   * `version`. An ACTIVATION approval is applied by `activate` instead (named by the entity, not the approval). */
  async execute(tenantId: string, userId: string, approvalId: string, body: { reason: string }): Promise<EventSupplementRead> {
    const a = await this.assertApproval(tenantId, approvalId)
    if (this.boundKind(a) !== 'AMENDMENT') throw new BadRequestException('Not an amendment approval; activate the entity directly')
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    const out = await this.approvals.execute({ tenantId, executorId: userId, approvalId, expectedAction: EVENT_SUPPLEMENT_APPROVAL_ACTION }, async (approval) => {
      const state = (approval.proposedState ?? {}) as { fingerprint: string; changes?: Record<string, unknown> }
      return this.prisma.withTenant(tenantId, async (tx) => {
        const current = await tx.eventSupplement.findFirst({ where: { id: approval.entityId, tenantId } })
        if (!current) throw new NotFoundException('Event supplement not found')
        if (current.status !== 'ACTIVE' && current.status !== 'SUSPENDED') throw new ConflictException('The supplement is no longer active or suspended')
        const errors: string[] = []
        const merged = this.mergedTerms(termsOf(current), (state.changes ?? {}) as Record<string, unknown>, errors)
        if (errors.length) throw new BadRequestException(errors.join('; '))
        const print = fingerprint(merged)
        if (print !== state.fingerprint) throw new ConflictException('The supplement changed since this amendment was reviewed')
        const nextVersion = current.version + 1
        await tx.eventSupplement.update({
          where: { id: current.id, tenantId },
          data: {
            amountKind: merged.amountKind, basis: merged.basis as SupplementBasis | null, frequency: merged.frequency as SupplementFrequency | null, amountMinor: merged.amountMinor === null ? null : BigInt(merged.amountMinor), percentBp: merged.percentBp,
            currency: merged.currency, taxTreatment: merged.taxTreatment, validFrom: new Date(`${merged.validFrom}T00:00:00.000Z`), validTo: new Date(`${merged.validTo}T00:00:00.000Z`),
            stackable: merged.stackable, priority: merged.priority, evidenceRef: merged.evidenceRef, version: nextVersion,
          },
        })
        await tx.eventSupplementVersion.create({ data: { tenantId, eventSupplementId: current.id, version: nextVersion, kind: 'AMENDMENT', terms: merged as unknown as Prisma.InputJsonValue, fingerprint: print, approvalId: approval.id, requestedById: approval.requestedById, approvedById: approval.decidedById!, appliedById: userId, reason } })
        const row = await tx.eventSupplement.findFirst({ where: { id: current.id, tenantId } })
        if (!row) throw new NotFoundException('Event supplement not found')
        return row
      })
    })
    await this.audit.record({ tenantId, userId, action: 'event_supplement.amended', entityType: ENTITY_TYPE, entityId: out.result.id, payload: { approvalId, version: out.result.version } })
    return this.view(out.result)
  }

  /** Single-actor: stops new applications without rewriting history (mirrors Contract.suspend, ADR 0067 F-01). */
  async suspend(tenantId: string, userId: string, id: string, body: EventSupplementSuspendInput): Promise<EventSupplementRead> {
    const current = await this.row(tenantId, id)
    if (current.status !== 'ACTIVE') throw new ConflictException('Only an active supplement can be suspended')
    const reason = textParam('reason', body?.reason, 500)
    if (!reason) throw new BadRequestException('A reason is required')
    await this.prisma.withTenant(tenantId, (tx) => tx.eventSupplement.update({ where: { id: current.id, tenantId }, data: { status: 'SUSPENDED', suspendedAt: new Date() } }))
    await this.audit.record({ tenantId, userId, action: 'event_supplement.suspended', entityType: ENTITY_TYPE, entityId: current.id, payload: { reason } })
    return this.view(await this.row(tenantId, id))
  }

  /**
   * Rate Impact Preview (spec section 7): compares the contracted base, the event-supplement total and the adjusted net, per room per
   * night, for a rate plan and a set of stay dates. Read-only: never mutates, never writes DailyRate. Reuses the exact pure functions
   * (`eventSupplementsForPlan`, `eventSupplementNights`) the authoritative evaluator uses, so a preview can never disagree with what
   * search, the tariff calendar or checkout would actually charge. Markup is not shown here: it depends on the buyer, which this
   * contract-and-plan-level preview does not take (CLAUDE.md invariant 10: never present a figure this endpoint cannot actually compute).
   */
  async preview(tenantId: string, body: EventSupplementPreviewRequest): Promise<EventSupplementPreviewResult> {
    const ratePlanId = idParam('ratePlanId', body?.ratePlanId)
    if (!ratePlanId) throw new BadRequestException('ratePlanId is required')
    const dates = Array.isArray(body?.stayDates) ? [...new Set(body.stayDates)].sort() : []
    if (dates.length < 1 || dates.length > 60) throw new BadRequestException('stayDates: 1 to 60 distinct calendar days')
    for (const date of dates) if (!dayParam('stayDates', date)) throw new BadRequestException(`stayDates: invalid day ${String(date)}`)
    const rooms = body?.rooms
    const adults = body?.adults
    const children = body?.children ?? 0
    if (!Number.isSafeInteger(rooms) || rooms < 1 || rooms > 20) throw new BadRequestException('rooms: an integer from 1 to 20')
    if (!Number.isSafeInteger(adults) || adults < 1) throw new BadRequestException('adults: a positive integer')
    if (!Number.isSafeInteger(children) || children < 0) throw new BadRequestException('children: a non-negative integer')

    const plan = await this.prisma.withTenant(tenantId, (tx) => tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { id: true, contractId: true, occupancy: true, currency: true } }))
    if (!plan) throw new NotFoundException('Rate plan not found')
    const firstDate = new Date(`${dates[0]}T00:00:00.000Z`)
    const lastDate = new Date(`${dates[dates.length - 1]}T00:00:00.000Z`)
    const [rates, supplementRows] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      tx.dailyRate.findMany({ where: { tenantId, ratePlanId: plan.id, occupancy: plan.occupancy, stayDate: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) } }, select: { stayDate: true, amountMinor: true, currency: true } }),
      tx.eventSupplement.findMany({
        where: { tenantId, contractId: plan.contractId, status: 'ACTIVE', roomEvent: { status: 'APPROVED' }, validFrom: { lte: lastDate }, validTo: { gte: firstDate } },
        select: { id: true, roomEventId: true, ratePlanId: true, amountKind: true, basis: true, frequency: true, amountMinor: true, percentBp: true, currency: true, validFrom: true, validTo: true, stackable: true, priority: true, roomEvent: { select: { name: true } } },
      }),
    ]))
    const byDate = new Map(rates.map((r) => [day(r.stayDate), r]))
    const missing = dates.filter((d) => !byDate.has(d))
    if (missing.length) throw new ConflictException(`No contracted Daily Rate for: ${missing.join(', ')} (never manufactured from an event supplement)`)
    const mismatched = rates.filter((r) => r.currency !== plan.currency)
    if (mismatched.length) throw new ConflictException('RATE_CURRENCY_MISMATCH')
    const nightBaseMinor = dates.map((d) => byDate.get(d)!.amountMinor)

    const rules = eventSupplementsForPlan({ id: plan.id }, supplementRows)
    if (rules.some((r) => r.currency !== plan.currency)) throw new ConflictException('EVENT_SUPPLEMENT_CURRENCY_MISMATCH')
    const extras = eventSupplementNights(rules, dates, { adults, children }, nightBaseMinor)
    if (extras.ambiguous) throw new ConflictException('EVENT_SUPPLEMENT_CONFLICT: two or more non-stackable rules of equal priority are eligible on the same night; review before pricing')

    const nights = dates.map((d, i) => {
      const base = nightBaseMinor[i]!
      const extra = extras.perNight[i]!
      return { date: d, contractedBaseMinor: base.toString(), eventSupplementMinor: extra.toString(), adjustedNetMinor: (base + extra).toString() }
    })
    const eventSupplements = extras.applied.map((item) => ({ roomEventId: item.roomEventId, roomEventName: item.roomEventName, amountMinor: (item.amountMinor * BigInt(rooms)).toString() }))
    return { currency: plan.currency, nights, eventSupplements }
  }
}
