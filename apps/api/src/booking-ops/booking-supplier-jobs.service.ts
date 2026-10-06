import { BadRequestException, ConflictException, ForbiddenException, Injectable, Inject, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import {
  BOOKING_STATUSES, BOOKING_SUPPLIER_OPS, type BookingAccessView, type BookingStatus, type BookingSupplierJobKind, type BookingSupplierJobStatus, type BookingSupplierOp,
  type BookingSupplierRequest, type BookingSupplierResult,
} from '@bedbanks/contracts'
import { BookingOpsDatabase } from './booking-ops-database'
import { BOOKING_SUPPLIER_RESOLVER, type BookingSupplierResolver } from './supplier/booking-supplier.port'

export const supplierJobsEnabled = (env: Record<string, string | undefined> = process.env) => env.ADMIN_SUPPLIER_JOBS_ENABLED === 'true'
export const supplierDispatchAllowed = supplierJobsEnabled
/** A job in one of these states is waiting for the runner or being run: there must be at most one per booking. UNKNOWN is waiting for a person. */
export const ACTIVE_JOB_STATUSES: BookingSupplierJobStatus[] = ['QUEUED', 'RUNNING', 'RETRY_WAIT']

const KEY = /^[A-Za-z0-9._:-]{8,128}$/
const bad = (message: string, code: string) => new BadRequestException({ message, code })
const KIND: Record<Exclude<BookingSupplierOp, 'retryNow'>, BookingSupplierJobKind> = { send: 'BOOK', cancel: 'CANCEL', sync: 'STATUS_CHECK' }

/** Which operations this booking allows right now, from facts only. The queue is consulted separately for "retry now". Pure, shared with the read model. */
export function supplierOpsFor(facts: { status: BookingStatus; closed: boolean; supplierStatus: string | null; hasActiveJob: boolean; hasRetryWaitJob: boolean; hasUnknownJob: boolean; configured: boolean }): BookingSupplierOp[] {
  if (facts.closed) return []
  const ops: BookingSupplierOp[] = []
  const idle = !facts.hasActiveJob
  if (facts.status === 'PENDING_SUPPLIER' && idle && facts.configured && !facts.hasUnknownJob && facts.supplierStatus !== 'UNKNOWN') ops.push('send')
  if (facts.status === 'CANCEL_REQUESTED' && idle && facts.configured) ops.push('cancel')
  if (facts.hasRetryWaitJob) ops.push('retryNow')
  if (idle && facts.configured && ['PENDING_SUPPLIER', 'ON_REQUEST', 'CANCEL_REQUESTED'].includes(facts.status)) ops.push('sync')
  return ops
}

/** Puts supplier work on the queue (ADR 0039, Phase 3). It never calls a supplier: the runner does, outside any request. */
@Injectable()
export class BookingSupplierJobsService {
  constructor(private readonly db: BookingOpsDatabase, @Inject(BOOKING_SUPPLIER_RESOLVER) private readonly suppliers: BookingSupplierResolver) {}

  async request(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingSupplierRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingSupplierResult> {
    if (typeof rawKey !== 'string' || !KEY.test(rawKey)) throw bad('An Idempotency-Key header of 8 to 128 letters, digits or . _ : - is required', 'IDEMPOTENCY_KEY_REQUIRED')
    if (!supplierJobsEnabled()) throw new ForbiddenException({ message: 'Supplier jobs are switched off in this environment', code: 'SUPPLIER_JOBS_DISABLED' })
    if (access.level !== 'OPERATOR' || !access.permissions.includes('booking.supplier.retry')) throw new ForbiddenException({ message: 'You do not have permission to use the supplier queue', code: 'PERMISSION_DENIED' })
    if (!body || !(BOOKING_SUPPLIER_OPS as readonly string[]).includes(body.op)) throw bad('Unknown supplier operation', 'UNKNOWN_OPERATION')
    if (!(BOOKING_STATUSES as readonly string[]).includes(body.expectedStatus)) throw bad('expectedStatus is required', 'INVALID_REQUEST')
    const op = body.op
    const fingerprint = createHash('sha256').update(JSON.stringify([bookingId, op, body.expectedStatus])).digest('hex')

    return this.db.withTenantWrite(tenantId, async (tx) => {
      // One writer at a time per booking: this lock is what makes "at most one active job" true under concurrent clicks.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`
      if (locked.length !== 1) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
      const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId }, select: { id: true, reference: true, supplier: true, status: true, closedAt: true, supplierStatus: true } })

      const earlier = await tx.bookingSupplierJob.findUnique({ where: { tenantId_bookingId_idempotencyKey: { tenantId, bookingId, idempotencyKey: rawKey } } })
      if (earlier) {
        if (earlier.requestFingerprint !== fingerprint) throw new ConflictException({ message: 'This idempotency key was already used for a different request', code: 'IDEMPOTENCY_CONFLICT' })
        return { bookingId, jobId: earlier.id, kind: earlier.kind, status: earlier.status, replayed: true }
      }
      if (booking.status !== body.expectedStatus) throw new ConflictException({ message: `The booking is now ${booking.status}, not ${body.expectedStatus}. Reload and try again.`, code: 'STALE_STATUS', currentStatus: booking.status })
      if (booking.closedAt) throw new ConflictException({ message: 'This booking is closed and locked for edits', code: 'BOOKING_CLOSED' })

      const jobs = await tx.bookingSupplierJob.findMany({ where: { tenantId, bookingId }, orderBy: { createdAt: 'desc' }, take: 20 })
      const active = jobs.filter((j) => (ACTIVE_JOB_STATUSES as string[]).includes(j.status))
      const configured = this.suppliers.resolve(tenantId, booking.supplier) !== null
      const allowed = supplierOpsFor({ status: booking.status as BookingStatus, closed: false, supplierStatus: booking.supplierStatus, hasActiveJob: active.length > 0, hasRetryWaitJob: active.some((j) => j.status === 'RETRY_WAIT'), hasUnknownJob: jobs[0]?.status === 'UNKNOWN', configured })
      if (!allowed.includes(op)) {
        const reason = !configured && op !== 'retryNow' ? 'SUPPLIER_NOT_CONFIGURED' : active.length > 0 && op !== 'retryNow' ? 'SUPPLIER_JOB_ACTIVE' : op === 'send' && (jobs[0]?.status === 'UNKNOWN' || booking.supplierStatus === 'UNKNOWN') ? 'SUPPLIER_STATE_UNKNOWN' : 'ILLEGAL_SUPPLIER_OPERATION'
        throw new ConflictException({ message: REFUSAL[reason], code: reason, currentStatus: booking.status })
      }

      let job: { id: string; kind: BookingSupplierJobKind; status: BookingSupplierJobStatus }
      if (op === 'retryNow') {
        const waiting = active.find((j) => j.status === 'RETRY_WAIT')!
        const moved = await tx.bookingSupplierJob.updateMany({ where: { id: waiting.id, tenantId, status: 'RETRY_WAIT' }, data: { runAfter: now } })
        if (moved.count !== 1) throw new ConflictException({ message: 'The job moved on. Reload and try again.', code: 'SUPPLIER_JOB_ACTIVE' })
        job = { id: waiting.id, kind: waiting.kind, status: 'RETRY_WAIT' }
      } else {
        job = await tx.bookingSupplierJob.create({ data: { tenantId, bookingId, kind: KIND[op], status: 'QUEUED', runAfter: now, requestedByUserId: userId, idempotencyKey: rawKey, requestFingerprint: fingerprint }, select: { id: true, kind: true, status: true } })
      }
      await tx.bookingEvent.create({ data: { tenantId, bookingId, fromStatus: booking.status, toStatus: booking.status, actorType: 'USER', actorId: userId, action: 'supplierQueued', payload: { op, kind: job.kind, jobId: job.id } } })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: `booking.supplier.${op}`, entityType: 'booking', entityId: bookingId, payload: { op, kind: job.kind, jobId: job.id, requestId } as Prisma.InputJsonValue }] })
      return { bookingId, jobId: job.id, kind: job.kind, status: job.status, replayed: false }
    })
  }
}

const REFUSAL: Record<string, string> = {
  SUPPLIER_NOT_CONFIGURED: 'No supplier adapter is configured for this booking’s supplier. Record the supplier’s answer by hand instead.',
  SUPPLIER_JOB_ACTIVE: 'A supplier job is already queued or running for this booking.',
  SUPPLIER_STATE_UNKNOWN: 'The supplier’s answer is not known. Sync with the supplier first; sending again could create a duplicate booking.',
  ILLEGAL_SUPPLIER_OPERATION: 'That supplier operation is not available for this booking now.',
}
