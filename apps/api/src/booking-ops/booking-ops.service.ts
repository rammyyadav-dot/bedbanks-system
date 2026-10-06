import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import {
  BOOKING_OPS_ANSWER_RULES, BOOKING_OPS_ANSWERS, BOOKING_OPS_MANUAL_PRIORITIES, BOOKING_OPS_REASON_MIN, BOOKING_REASON_MAX, BOOKING_REF_MAX, BOOKING_STATUSES, type BookingAccessView, type BookingOpsAcknowledgeRequest, type BookingOpsAnswer,
  type BookingOpsAnswerRequest, type BookingOpsAssignee, type BookingOpsAssignRequest, type BookingOpsClearRequest, type BookingOpsEscalateRequest, type BookingOpsNoteRequest, type BookingOpsWriteResult, type BookingStatus,
} from '@bedbanks/contracts'
import { membershipGrantsPermission } from '../agent/agent-permissions'
import { PrismaService } from '../database/prisma.service'
import { BookingOpsDatabase } from './booking-ops-database'
import { OPS_BOOKING_SELECT, type OpsBookingRow } from './booking-ops-facts'
import { BookingOpsQueueService, requireOpsView, slaPolicy } from './booking-ops-queue.service'
import { transitionBooking } from './booking-transition'

const KEY = /^[A-Za-z0-9._:-]{8,128}$/
type Tx = Prisma.TransactionClient
const bad = (message: string, code = 'VALIDATION_ERROR') => new BadRequestException({ message, code })
const conflict = (message: string, code = 'BOOKING_OPS_CONFLICT', extra: Record<string, unknown> = {}) => new ConflictException({ message, code, ...extra })
const invalid = (message: string) => new ConflictException({ message, code: 'BOOKING_OPS_INVALID_TRANSITION' })
const text = (v: unknown, label: string, min: number, max: number): string => {
  if (typeof v !== 'string') throw bad(`${label} is required`)
  const t = v.trim(); if (t.length < min) throw new UnprocessableEntityException({ message: `${label} needs at least ${min} characters`, code: 'MISSING_FIELDS', fields: [label] })
  if (t.length > max) throw bad(`${label} is too long (max ${max})`, 'FIELD_TOO_LONG'); return t
}
const optionalRef = (v: unknown, label: string, max = BOOKING_REF_MAX): string | undefined => { if (v === undefined || v === null || v === '') return undefined; if (typeof v !== 'string') throw bad(`${label} must be text`); const t = v.trim(); if (t.length > max) throw bad(`${label} is too long`, 'FIELD_TOO_LONG'); return t || undefined }
const fingerprint = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

interface Ctx { tx: Tx; tenantId: string; userId: string; row: OpsBookingRow; key: string; fp: string; now: Date; requestId: string }

/**
 * The operator's actions on an operations case (ADR 0039, Phase 4): assign, acknowledge, escalate, note, record the supplier's answer, clear a manual follow-up.
 * Every action: formal permission, tenant from the session, one transaction on the booking role that locks the booking row (so concurrent actions are serialised),
 * an Idempotency-Key, an immutable BookingEvent, and an AuditEvent. Owner-and-version compare-and-set stops two people silently overwriting each other.
 * No supplier is ever called here and nothing here holds a transaction open across one. The supplier queue (Phase 3) does that, elsewhere.
 */
@Injectable()
export class BookingOpsService {
  constructor(private readonly db: BookingOpsDatabase, private readonly prisma: PrismaService, private readonly queue: BookingOpsQueueService) {}

  // ---- who can own a case ---------------------------------------------------------------------------------------------
  /** Staff of THIS tenant who may work the queue (formal `booking.ops.view` and operator-level read). Never anyone from another tenant; no emails. */
  async assignees(tenantId: string, access: BookingAccessView): Promise<BookingOpsAssignee[]> {
    requireOpsView(access)
    return this.eligibleStaff(tenantId)
  }
  private async eligibleStaff(tenantId: string): Promise<BookingOpsAssignee[]> {
    const rows = await this.prisma.withTenant(tenantId, (t) => t.userRole.findMany({
      where: { tenantId, role: { tenantId, permissions: { some: { permission: { key: 'booking.ops.view' } } } }, user: { memberships: { some: { tenantId } }, status: 'ACTIVE' } },
      select: { userId: true, user: { select: { id: true, name: true, email: true, memberships: { where: { tenantId }, select: { role: true } } } }, role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } },
    }))
    const byUser = new Map<string, { name: string; role: string; keys: Set<string> }>()
    for (const r of rows) { const e = byUser.get(r.userId) ?? { name: r.user.name || r.user.email, role: r.user.memberships[0]?.role ?? '', keys: new Set<string>() }; for (const p of r.role.permissions) e.keys.add(p.permission.key); byUser.set(r.userId, e) }
    return [...byUser.entries()].filter(([, e]) => membershipGrantsPermission(e.role, [...e.keys], 'booking.read')).map(([id, e]) => ({ id, name: e.name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }
  private async assertAssignable(tenantId: string, userId: string): Promise<void> {
    const membership = await this.prisma.withTenant(tenantId, (t) => t.membership.findUnique({ where: { userId_tenantId: { userId, tenantId } }, select: { role: true } }))
    if (!membership) throw new ForbiddenException({ message: 'That user does not belong to this tenant', code: 'BOOKING_OPS_CROSS_TENANT_DENIED' })
    if (!(await this.eligibleStaff(tenantId)).some((a) => a.id === userId)) throw new ForbiddenException({ message: 'That user cannot work the operations queue', code: 'BOOKING_OPS_INELIGIBLE_ASSIGNEE' })
  }

  // ---- shared plumbing --------------------------------------------------------------------------------------------------
  private async run(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, permission: string, rawKey: unknown, parts: unknown, requestId: string, now: Date, work: (c: Ctx) => Promise<Omit<BookingOpsWriteResult, 'replayed'>>): Promise<BookingOpsWriteResult> {
    requireOpsView(access)
    if (!access.permissions.includes(permission)) throw new ForbiddenException({ message: 'You do not have permission for this operations action', code: 'BOOKING_OPS_FORBIDDEN' })
    if (typeof rawKey !== 'string' || !KEY.test(rawKey)) throw bad('An Idempotency-Key header of 8 to 128 letters, digits or . _ : - is required', 'IDEMPOTENCY_KEY_REQUIRED')
    const fp = fingerprint(parts)
    return this.db.withTenantWrite(tenantId, async (tx) => {
      // The lock serialises every operations action, supplier job enqueue and manual answer on this booking.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`
      if (locked.length !== 1) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
      const row = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId }, select: OPS_BOOKING_SELECT })
      const earlier = await tx.bookingEvent.findUnique({ where: { tenantId_bookingId_idempotencyKey: { tenantId, bookingId, idempotencyKey: rawKey } }, select: { requestFingerprint: true } })
      if (earlier) {
        if (earlier.requestFingerprint !== fp) throw conflict('This idempotency key was already used for a different request', 'IDEMPOTENCY_CONFLICT')
        return { bookingId, reference: row.reference, status: row.status as BookingStatus, opsVersion: row.opsState?.version ?? 0, replayed: true }
      }
      return { ...(await work({ tx, tenantId, userId, row, key: rawKey, fp, now, requestId })), replayed: false }
    })
  }

  private async eval(c: Ctx) { return (await this.queue.evaluateOne(c.tx, c.tenantId, c.row.id, c.now, slaPolicy()))! }

  /** Compare-and-set on the operational state: the caller must have seen the current version (0 when no state exists). */
  private async writeState(c: Ctx, expectedVersion: number, data: Prisma.BookingOpsStateUncheckedUpdateManyInput): Promise<number> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw bad('expectedVersion is required')
    const current = c.row.opsState
    if (!current) {
      if (expectedVersion !== 0) throw conflict('This case changed while you were working. Reload and try again.', 'BOOKING_OPS_CONFLICT', { currentVersion: 0 })
      await c.tx.bookingOpsState.create({ data: { ...(data as object), tenantId: c.tenantId, bookingId: c.row.id, version: 1 } as Prisma.BookingOpsStateUncheckedCreateInput, select: { id: true } })
      return 1
    }
    const moved = await c.tx.bookingOpsState.updateMany({ where: { tenantId: c.tenantId, bookingId: c.row.id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } })
    if (moved.count !== 1) throw conflict('This case changed while you were working. Reload and try again.', 'BOOKING_OPS_CONFLICT', { currentVersion: current.version, assigneeUserId: current.assigneeUserId })
    return expectedVersion + 1
  }

  private async record(c: Ctx, action: string, auditAction: string, payload: Record<string, unknown>, reason: string | null, audit: Record<string, unknown>): Promise<void> {
    await c.tx.bookingEvent.create({ data: { tenantId: c.tenantId, bookingId: c.row.id, fromStatus: c.row.status, toStatus: c.row.status, actorType: 'USER', actorId: c.userId, reason, action, payload: payload as Prisma.InputJsonValue, idempotencyKey: c.key, requestFingerprint: c.fp } })
    // Free text (reason, evidence) stays in the immutable event for operators; the audit payload carries facts and ids only.
    await c.tx.auditEvent.createMany({ data: [{ tenantId: c.tenantId, userId: c.userId, actorType: 'USER', action: auditAction, entityType: 'booking', entityId: c.row.id, payload: { ...audit, requestId: c.requestId } as Prisma.InputJsonValue }] })
  }
  private result(c: Ctx, status: BookingStatus, version: number) { return { bookingId: c.row.id, reference: c.row.reference, status, opsVersion: version } }

  // ---- assignment ---------------------------------------------------------------------------------------------------------
  async assign(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingOpsAssignRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingOpsWriteResult> {
    if (!body || (body.assigneeUserId !== null && typeof body.assigneeUserId !== 'string')) throw bad('assigneeUserId must be a user id or null')
    if (body.assigneeUserId !== null) { requireOpsView(access); if (access.permissions.includes('booking.ops.assign')) await this.assertAssignable(tenantId, body.assigneeUserId) }
    return this.run(tenantId, userId, access, bookingId, 'booking.ops.assign', rawKey, ['assign', bookingId, body.assigneeUserId, body.expectedVersion], requestId, now, async (c) => {
      const e = await this.eval(c)
      if (!e.evaluation.inQueue) throw invalid('This booking is not an open operations case')
      const from = e.evaluation.assigneeUserId
      if (from === body.assigneeUserId) throw invalid(from ? 'That user already owns this case' : 'This case is already unassigned')
      const version = await this.writeState(c, body.expectedVersion, body.assigneeUserId
        ? { assigneeUserId: body.assigneeUserId, assignedAt: now, assignedByUserId: userId, acknowledgedAt: null, acknowledgedByUserId: null }
        : { assigneeUserId: null, assignedAt: null, assignedByUserId: userId, acknowledgedAt: null, acknowledgedByUserId: null })
      await this.record(c, body.assigneeUserId ? 'opsAssigned' : 'opsUnassigned', body.assigneeUserId ? 'booking.ops.assigned' : 'booking.ops.unassigned', { from, to: body.assigneeUserId }, null, { from, to: body.assigneeUserId })
      return this.result(c, c.row.status as BookingStatus, version)
    })
  }

  async acknowledge(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingOpsAcknowledgeRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingOpsWriteResult> {
    return this.run(tenantId, userId, access, bookingId, 'booking.ops.assign', rawKey, ['ack', bookingId, body?.expectedVersion], requestId, now, async (c) => {
      const e = await this.eval(c)
      if (!e.evaluation.inQueue) throw invalid('This booking is not an open operations case')
      if (e.evaluation.assigneeUserId !== userId) throw invalid('Only the person who owns a case can acknowledge it')
      if (e.evaluation.acknowledgedAt) throw invalid('This case is already acknowledged')
      const version = await this.writeState(c, body.expectedVersion, { acknowledgedAt: now, acknowledgedByUserId: userId })
      await this.record(c, 'opsAcknowledged', 'booking.ops.acknowledged', {}, null, {})
      return this.result(c, c.row.status as BookingStatus, version)
    })
  }

  // ---- escalation and follow-up ---------------------------------------------------------------------------------------------
  async escalate(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingOpsEscalateRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingOpsWriteResult> {
    const reason = text(body?.reason, 'reason', BOOKING_OPS_REASON_MIN, BOOKING_REASON_MAX)
    if (body.priority !== null && !(BOOKING_OPS_MANUAL_PRIORITIES as readonly string[]).includes(body.priority as string)) throw bad('priority must be HIGH, URGENT, CRITICAL or null')
    if (body.priority === null && body.followUp !== true && body.followUp !== false) throw bad('Give a priority, or followUp true/false')
    return this.run(tenantId, userId, access, bookingId, 'booking.ops.escalate', rawKey, ['escalate', bookingId, body.priority, body.followUp ?? null, reason, body.expectedVersion], requestId, now, async (c) => {
      if (c.row.closedAt) throw invalid('This booking is closed')
      const state = c.row.opsState
      const raising = body.priority !== null
      if (!raising && body.followUp !== true && !(state && (state.manualPriority || state.followUp) && !state.resolvedAt)) throw invalid('There is no escalation or follow-up to clear')
      const data: Prisma.BookingOpsStateUncheckedUpdateManyInput = { resolvedAt: null, resolvedByUserId: null }
      if (raising) Object.assign(data, { manualPriority: body.priority, escalatedAt: now, escalatedByUserId: userId, escalationReason: reason })
      else if (body.followUp === false || body.followUp === undefined) Object.assign(data, { manualPriority: null, escalatedAt: null, escalatedByUserId: null, escalationReason: null })
      if (body.followUp === true) Object.assign(data, { followUp: true, followUpAt: state?.followUp && state.followUpAt ? state.followUpAt : now })
      else if (body.followUp === false) Object.assign(data, { followUp: false, followUpAt: null })
      const version = await this.writeState(c, body.expectedVersion, data)
      await this.record(c, raising || body.followUp === true ? 'opsEscalated' : 'opsDeescalated', raising || body.followUp === true ? 'booking.ops.escalated' : 'booking.ops.deescalated', { priority: body.priority, followUp: body.followUp ?? null }, reason, { priority: body.priority, followUp: body.followUp ?? null, reasonGiven: true })
      return this.result(c, c.row.status as BookingStatus, version)
    })
  }

  async clearFollowUp(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingOpsClearRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingOpsWriteResult> {
    const reason = text(body?.reason, 'reason', BOOKING_OPS_REASON_MIN, BOOKING_REASON_MAX)
    return this.run(tenantId, userId, access, bookingId, 'booking.ops.resolve', rawKey, ['clear', bookingId, reason, body.expectedVersion], requestId, now, async (c) => {
      const s = c.row.opsState
      if (!s || s.resolvedAt || !(s.followUp || s.manualPriority)) throw invalid('There is no manual follow-up or escalation to resolve')
      const e = await this.eval(c)
      const onlyManual = e.evaluation.reasons.length === 1 && e.evaluation.reasons[0] === 'MANUAL_FOLLOW_UP'
      const version = await this.writeState(c, body.expectedVersion, { followUp: false, followUpAt: null, manualPriority: null, escalatedAt: null, escalatedByUserId: null, escalationReason: null, resolvedAt: now, resolvedByUserId: userId,
        ...(onlyManual ? { assigneeUserId: null, assignedAt: null, acknowledgedAt: null, acknowledgedByUserId: null } : {}) })
      await this.record(c, 'opsResolved', 'booking.ops.resolved', { stillOpen: !onlyManual }, reason, { stillOpen: !onlyManual, reasonGiven: true })
      return this.result(c, c.row.status as BookingStatus, version)
    })
  }

  async note(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingOpsNoteRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingOpsWriteResult> {
    const note = text(body?.note, 'note', 3, BOOKING_REASON_MAX)
    return this.run(tenantId, userId, access, bookingId, 'booking.ops.note', rawKey, ['note', bookingId, note], requestId, now, async (c) => {
      await this.record(c, 'opsNote', 'booking.ops.noted', {}, note, { noteGiven: true })
      return this.result(c, c.row.status as BookingStatus, c.row.opsState?.version ?? 0)
    })
  }

  // ---- the supplier's answer, recorded by a person --------------------------------------------------------------------------
  /**
   * The supplier's answer is uncertain or cannot be obtained, and an authorised person has it from the supplier. Each answer is a named, evidenced fact with its own
   * rule; there is no generic "set status". "The supplier has no booking" is a different fact from "the supplier rejected it": only the former, with evidence and an
   * idle queue, clears the unknown outcome and makes sending again safe. Nothing here calls a supplier.
   */
  async answer(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingOpsAnswerRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingOpsWriteResult> {
    if (!body || !(BOOKING_OPS_ANSWERS as readonly string[]).includes(body.answer)) throw bad('Unknown supplier answer', 'UNKNOWN_ANSWER')
    if (!(BOOKING_STATUSES as readonly string[]).includes(body.expectedStatus)) throw bad('expectedStatus is required')
    const answer = body.answer as BookingOpsAnswer; const rule = BOOKING_OPS_ANSWER_RULES[answer]
    const reason = text(body.reason, 'reason', BOOKING_OPS_REASON_MIN, BOOKING_REASON_MAX)
    const supplierRef = optionalRef(body.supplierRef, 'supplierRef'); const hotelConfirmationNo = optionalRef(body.hotelConfirmationNo, 'hotelConfirmationNo'); const supplierCancellationRef = optionalRef(body.supplierCancellationRef, 'supplierCancellationRef')
    const evidenceRef = optionalRef(body.evidenceRef, 'evidenceRef', 160)
    return this.run(tenantId, userId, access, bookingId, 'booking.ops.resolve', rawKey, ['answer', bookingId, answer, body.expectedStatus, reason, supplierRef ?? null, hotelConfirmationNo ?? null, supplierCancellationRef ?? null, evidenceRef ?? null], requestId, now, async (c) => {
      const row = c.row; const status = row.status as BookingStatus
      if (row.closedAt) throw invalid('This booking is closed and locked')
      if (status !== body.expectedStatus) throw conflict(`The booking is now ${status}, not ${body.expectedStatus}. Reload and try again.`, 'BOOKING_OPS_CONFLICT', { currentStatus: status })
      if (!rule.from.includes(status)) throw invalid(`“${answer}” is not a valid answer for a booking that is ${status}`)
      if (rule.requires.includes('reference') && !(answer === 'SUPPLIER_CANCELLED' ? supplierCancellationRef : supplierRef)) throw new UnprocessableEntityException({ message: answer === 'SUPPLIER_CANCELLED' ? 'The supplier’s cancellation reference is required' : 'The supplier’s booking reference is required', code: 'MISSING_FIELDS', fields: [answer === 'SUPPLIER_CANCELLED' ? 'supplierCancellationRef' : 'supplierRef'] })
      if (rule.requires.includes('evidence') && (!evidenceRef || evidenceRef.length < 3)) throw new UnprocessableEntityException({ message: 'Who at the supplier told you, and any reference they gave, is required before a booking can be treated as absent', code: 'MISSING_FIELDS', fields: ['evidenceRef'] })
      const jobs = await c.tx.bookingSupplierJob.findMany({ where: { tenantId, bookingId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5, select: { id: true, status: true } })
      const active = jobs.some((j) => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(j.status))
      if (rule.needsNoActiveJob && active) throw conflict('A supplier job is queued or running for this booking. Wait for it, or retry it first: recording this now could be overtaken by it.', 'BOOKING_OPS_CONFLICT')
      // Every job still marked UNKNOWN for this booking is answered by a person's evidence: none may be left claiming the outcome is unknown.
      const closeUnknown = async (code: string) => { await c.tx.bookingSupplierJob.updateMany({ where: { tenantId, bookingId, status: 'UNKNOWN' }, data: { status: 'SUCCEEDED', lastErrorCode: code, lockedUntil: null, completedAt: now } }) }
      const move = (action: 'systemConfirm' | 'systemConfirmOnRequest' | 'systemOnRequest' | 'systemFail' | 'systemRejectOnRequest' | 'systemCompleteCancellation', supplierStatus: string) =>
        transitionBooking(c.tx, { tenantId, bookingId, action, expectedStatus: status, actor: { type: 'USER', id: userId }, level: 'SYSTEM', now, reason, supplierRef, hotelConfirmationNo, supplierCancellationRef, supplierStatus })
      let to: BookingStatus = status
      switch (answer) {
        case 'SUPPLIER_CONFIRMED': to = (await move(status === 'ON_REQUEST' ? 'systemConfirmOnRequest' : 'systemConfirm', 'CONFIRMED')).status; await closeUnknown('MANUAL_ANSWER'); break
        case 'SUPPLIER_ON_REQUEST': to = (await move('systemOnRequest', 'ON_REQUEST')).status; await closeUnknown('MANUAL_ANSWER'); break
        case 'SUPPLIER_REJECTED': to = (await move(status === 'ON_REQUEST' ? 'systemRejectOnRequest' : 'systemFail', 'REJECTED')).status; await closeUnknown('MANUAL_ANSWER'); break
        case 'SUPPLIER_CANCELLED': to = (await move('systemCompleteCancellation', 'CANCELLED')).status; await closeUnknown('MANUAL_ANSWER'); break
        case 'SUPPLIER_HAS_NO_BOOKING':
          // Authoritative evidence that nothing exists at the supplier: clears the unknown outcome so "Send to supplier" becomes safe again. The status does not change.
          await c.tx.booking.updateMany({ where: { id: bookingId, tenantId, closedAt: null, status }, data: { supplierStatus: 'NOT_FOUND' } }); await closeUnknown('MANUAL_NO_BOOKING')
          await c.tx.bookingEvent.create({ data: { tenantId, bookingId, fromStatus: status, toStatus: status, actorType: 'USER', actorId: userId, action: 'supplierNotFound', reason, payload: { manual: true, evidenceGiven: true } } }); break
        case 'SUPPLIER_REFUSED_CANCELLATION':
          await c.tx.booking.updateMany({ where: { id: bookingId, tenantId, closedAt: null, status }, data: { supplierStatus: 'CANCEL_FAILED' } })
          await c.tx.bookingEvent.create({ data: { tenantId, bookingId, fromStatus: status, toStatus: status, actorType: 'USER', actorId: userId, action: 'supplierCancelFailed', reason, payload: { manual: true } } }); break
        case 'STILL_AWAITING_SUPPLIER': break
      }
      // The case may be new to operations state: a person recording an answer owns the follow-up for what they asked.
      await this.record(c, 'opsAnswer', 'booking.ops.answer_recorded', { answer, from: status, to, evidence: evidenceRef ?? null }, reason, { answer, from: status, to, evidenceGiven: Boolean(evidenceRef), reasonGiven: true })
      return this.result(c, to, c.row.opsState?.version ?? 0)
    })
  }
}
