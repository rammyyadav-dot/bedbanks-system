import { ConflictException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { BOOKING_SUPPLIER_MAX_ATTEMPTS, BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS, type BookingAction, type BookingStatus, type BookingSupplierJobKind } from '@bedbanks/contracts'
import { BookingOpsDatabase } from './booking-ops-database'
import { transitionBooking } from './booking-transition'
import {
  BookingSupplierCallError, BOOKING_SUPPLIER_RESOLVER, type BookingSupplierBookResult, type BookingSupplierPort, type BookingSupplierResolver, type BookingSupplierStatus,
} from './supplier/booking-supplier.port'

const BATCH = 10
const LOCK_SECONDS = 120
const MIN_INTERVAL_MS = 1_000
const DEFAULT_INTERVAL_MS = 15_000
type Tx = Prisma.TransactionClient
interface Claimed { id: string; tenantId: string; bookingId: string; kind: BookingSupplierJobKind; attempt: number; requestedByUserId: string | null }
interface Facts { id: string; reference: string; supplier: string; status: BookingStatus; closedAt: Date | null; currency: string; totalMinor: bigint; checkIn: string | null; checkOut: string | null; supplierRef: string | null; rooms: Array<{ roomName: string | null; boardCode: string | null; adults: number; children: number; childAges: number[] }> }

/**
 * Runs the Admin booking supplier queue (ADR 0039, Phase 3). Off unless `BOOKING_JOB_RUNNER_ENABLED=true`, and it then needs the booking module's own database
 * credential: it uses nothing broader. Supplier calls happen here, outside any HTTP request and outside any database transaction, so a slow supplier hangs
 * nobody and holds no lock.
 *
 * The rule that matters: a call that throws (timeout, transport) is NOT an answer. Before the booking may be called failed, the runner asks the supplier
 * what it holds under our reference. Only a definite "nothing held" can lead to a retry or to Failed; if the supplier cannot be asked, the job goes UNKNOWN,
 * the booking stays Pending supplier and a person syncs. That is how a timeout never produces a ghost booking or a duplicate.
 */
@Injectable()
export class BookingSupplierRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingSupplierRunner.name)
  private timer?: NodeJS.Timeout
  private running = false

  constructor(private readonly db: BookingOpsDatabase, @Inject(BOOKING_SUPPLIER_RESOLVER) private readonly suppliers: BookingSupplierResolver, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  onModuleInit(): void {
    if (this.env.BOOKING_JOB_RUNNER_ENABLED !== 'true') return
    if (!this.db.configured()) throw new Error('BOOKING_JOB_RUNNER_ENABLED requires BOOKING_OPS_DATABASE_URL (a different credential from DATABASE_URL)')
    const interval = Number(this.env.BOOKING_JOB_RUNNER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`BOOKING_JOB_RUNNER_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Booking supplier runner enabled every ${interval}ms`)
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass: every tenant with a due job, up to a batch each. Never overlaps itself. Returns the number of jobs processed. */
  async runOnce(now: () => Date = () => new Date()): Promise<number> {
    if (this.running) return 0
    this.running = true
    let processed = 0
    try {
      for (const tenantId of await this.db.dueTenants(now())) {
        try {
          for (const job of await this.claim(tenantId, now())) { await this.process(job, now); processed += 1 }
        } catch (error) { this.logger.error(`Supplier jobs failed for a tenant: ${error instanceof Error ? error.name : 'unknown error'}`) }
      }
    } catch (error) { this.logger.error(`Supplier runner could not list due tenants: ${error instanceof Error ? error.name : 'unknown error'}`) } finally { this.running = false }
    return processed
  }

  /** Marks due jobs RUNNING with a lock and counts the attempt. SKIP LOCKED lets two runners share the table without taking the same job. */
  private async claim(tenantId: string, now: Date): Promise<Claimed[]> {
    return this.db.withTenantWrite(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BookingSupplierJob" WHERE "tenant_id" = ${tenantId} AND (("status" IN ('QUEUED','RETRY_WAIT') AND "run_after" <= ${now}) OR ("status" = 'RUNNING' AND "locked_until" <= ${now})) ORDER BY "run_after" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`
      const out: Claimed[] = []
      for (const { id } of rows) {
        const job = await tx.bookingSupplierJob.findFirstOrThrow({ where: { id, tenantId } })
        if (job.attempt >= job.maxAttempts) {
          // A runner died during the last attempt: we cannot know what the supplier did.
          await tx.bookingSupplierJob.update({ where: { id }, data: { status: 'UNKNOWN', lockedUntil: null, lastErrorCode: 'RUNNER_LOST' } })
          continue
        }
        await tx.bookingSupplierJob.update({ where: { id }, data: { status: 'RUNNING', attempt: { increment: 1 }, lockedUntil: new Date(now.getTime() + LOCK_SECONDS * 1000) } })
        out.push({ id, tenantId, bookingId: job.bookingId, kind: job.kind, attempt: job.attempt + 1, requestedByUserId: job.requestedByUserId })
      }
      return out
    })
  }

  private async facts(job: Claimed): Promise<Facts | null> {
    return this.db.withTenantWrite(job.tenantId, async (tx) => {
      const b = await tx.booking.findFirst({ where: { id: job.bookingId, tenantId: job.tenantId }, include: { rooms: { orderBy: { position: 'asc' } } } })
      if (!b) return null
      return { id: b.id, reference: b.reference, supplier: b.supplier, status: b.status as BookingStatus, closedAt: b.closedAt, currency: b.currency, totalMinor: b.totalMinor, supplierRef: b.supplierRef,
        checkIn: b.checkIn ? b.checkIn.toISOString().slice(0, 10) : null, checkOut: b.checkOut ? b.checkOut.toISOString().slice(0, 10) : null,
        rooms: b.rooms.map((r) => ({ roomName: r.roomName, boardCode: r.boardCode, adults: r.adults, children: r.children, childAges: r.childAges })) }
    })
  }

  private async process(job: Claimed, now: () => Date): Promise<void> {
    const facts = await this.facts(job)
    if (!facts) return this.finish(job, 'FAILED', 'BOOKING_NOT_FOUND', now())
    const adapter = this.suppliers.resolve(job.tenantId, facts.supplier)
    // Nothing to do if the booking already moved (a person recorded the answer, or this job's own earlier result landed before a crash).
    const applicable = job.kind === 'BOOK' ? facts.status === 'PENDING_SUPPLIER' : job.kind === 'CANCEL' ? facts.status === 'CANCEL_REQUESTED' : ['PENDING_SUPPLIER', 'ON_REQUEST', 'CANCEL_REQUESTED'].includes(facts.status)
    if (facts.closedAt || !applicable) return this.finish(job, 'SUCCEEDED', 'ALREADY_APPLIED', now())
    if (!adapter) return this.finish(job, 'FAILED', 'SUPPLIER_NOT_CONFIGURED', now()) // a configuration problem is not a supplier answer: the booking is left as it is
    const context = { tenantId: job.tenantId, requestId: `job:${job.id}:${job.attempt}` }
    try {
      if (job.kind === 'BOOK') await this.book(job, facts, adapter, context, now)
      else if (job.kind === 'CANCEL') await this.cancel(job, facts, adapter, context, now)
      else await this.sync(job, facts, adapter, context, now)
    } catch (error) {
      // The booking was settled by someone else while the supplier call was in flight (an operator recorded the answer first): the supplier call is already in the log, and
      // applying a second result would be wrong. The job is finished, not retried: a retry would be a second booking request.
      if (error instanceof ConflictException && ['STALE_STATUS', 'ILLEGAL_TRANSITION', 'BOOKING_CLOSED'].includes((error.getResponse() as { code?: string }).code ?? '')) return this.finish(job, 'SUCCEEDED', 'ALREADY_APPLIED', now())
      // A bug or a database failure, not a supplier answer. The job is released for another go and the failure is visible, never swallowed into success.
      this.logger.error(`Supplier job ${job.id} errored: ${error instanceof Error ? error.name : 'unknown error'}`)
      await this.retryOrStop(job, 'RUNNER_ERROR', now(), 'UNKNOWN')
    }
  }

  // ---- BOOK -------------------------------------------------------------------------------------------------------------
  private async book(job: Claimed, f: Facts, adapter: BookingSupplierPort, ctx: { tenantId: string; requestId: string }, now: () => Date): Promise<void> {
    const started = Date.now()
    let result: BookingSupplierBookResult
    try {
      result = await adapter.book(ctx, { reference: f.reference, supplierKey: f.supplier, checkIn: f.checkIn, checkOut: f.checkOut, currency: f.currency, sellMinor: f.totalMinor, rooms: f.rooms })
    } catch (error) {
      const failure = error instanceof BookingSupplierCallError ? error : new BookingSupplierCallError('error', 'SUPPLIER_ERROR')
      await this.logCall(job, f, 'BOOK', failure.kind === 'timeout' ? 'TIMEOUT' : 'ERROR', { errorCode: failure.code, httpStatus: failure.httpStatus, durationMs: Date.now() - started })
      // Did the supplier act anyway? Ask by our reference before concluding anything.
      const seen = await this.statusOrNull(job, f, adapter, ctx)
      if (seen === 'INCONCLUSIVE') return this.markUnknown(job, f, failure.code, now())
      if (seen.found) return this.applyBooked(job, f, { outcome: seen.state === 'ON_REQUEST' ? 'ON_REQUEST' : 'CONFIRMED', supplierRef: seen.supplierRef, hotelConfirmationNo: seen.hotelConfirmationNo }, seen.state, now())
      return this.retryOrStop(job, failure.code, now(), 'FAILED', f)
    }
    await this.logCall(job, f, 'BOOK', result.outcome, { errorCode: result.outcome === 'REJECTED' ? result.code : null, durationMs: Date.now() - started, supplierRef: result.outcome === 'REJECTED' ? null : result.supplierRef })
    if (result.outcome === 'REJECTED') return this.failBooking(job, f, `Supplier rejected the booking (${result.code})`, 'REJECTED', now())
    return this.applyBooked(job, f, result, result.outcome, now())
  }

  private async applyBooked(job: Claimed, f: Facts, r: { outcome: 'CONFIRMED' | 'ON_REQUEST'; supplierRef: string | null; hotelConfirmationNo: string | null }, supplierWord: string, at: Date): Promise<void> {
    const action: BookingAction = r.outcome === 'CONFIRMED' ? 'systemConfirm' : 'systemOnRequest'
    await this.move(job, f, action, { supplierRef: r.supplierRef ?? undefined, hotelConfirmationNo: r.hotelConfirmationNo ?? undefined, supplierStatus: supplierWord }, 'SUCCEEDED', null, at)
  }

  private async failBooking(job: Claimed, f: Facts, reason: string, supplierWord: string, at: Date): Promise<void> {
    await this.move(job, f, 'systemFail', { reason, supplierStatus: supplierWord }, 'SUCCEEDED', null, at)
  }

  // ---- CANCEL -----------------------------------------------------------------------------------------------------------
  private async cancel(job: Claimed, f: Facts, adapter: BookingSupplierPort, ctx: { tenantId: string; requestId: string }, now: () => Date): Promise<void> {
    const started = Date.now()
    try {
      const r = await adapter.cancel(ctx, { reference: f.reference, supplierKey: f.supplier, supplierRef: f.supplierRef })
      await this.logCall(job, f, 'CANCEL', r.outcome, { errorCode: r.outcome === 'REJECTED' ? r.code : null, durationMs: Date.now() - started, supplierRef: r.outcome === 'CANCELLED' ? r.supplierCancellationRef : null })
      if (r.outcome === 'CANCELLED') return this.move(job, f, 'systemCompleteCancellation', { supplierCancellationRef: r.supplierCancellationRef ?? undefined, supplierStatus: 'CANCELLED' }, 'SUCCEEDED', null, now())
      return this.cancelFailed(job, f, r.code, now())
    } catch (error) {
      const failure = error instanceof BookingSupplierCallError ? error : new BookingSupplierCallError('error', 'SUPPLIER_ERROR')
      await this.logCall(job, f, 'CANCEL', failure.kind === 'timeout' ? 'TIMEOUT' : 'ERROR', { errorCode: failure.code, httpStatus: failure.httpStatus, durationMs: Date.now() - started })
      const seen = await this.statusOrNull(job, f, adapter, ctx)
      if (seen !== 'INCONCLUSIVE' && seen.found && seen.state === 'CANCELLED') return this.move(job, f, 'systemCompleteCancellation', { supplierCancellationRef: seen.supplierCancellationRef ?? undefined, supplierStatus: 'CANCELLED' }, 'SUCCEEDED', null, now())
      if (seen === 'INCONCLUSIVE' || !seen.found) return this.markUnknown(job, f, failure.code, now())
      return this.retryOrStop(job, failure.code, now(), 'FAILED', f, true)
    }
  }

  /** The supplier refused, or kept refusing, the cancellation. The booking stays Cancel requested for a person to settle; it is not silently dropped. */
  private async cancelFailed(job: Claimed, f: Facts, code: string, at: Date): Promise<void> {
    await this.db.withTenantWrite(job.tenantId, async (tx) => {
      await tx.booking.updateMany({ where: { id: f.id, tenantId: job.tenantId, closedAt: null }, data: { supplierStatus: 'CANCEL_FAILED' } })
      await tx.bookingEvent.create({ data: { tenantId: job.tenantId, bookingId: f.id, fromStatus: f.status, toStatus: f.status, actorType: 'SUPPLIER', action: 'supplierCancelFailed', reason: null, payload: { code, jobId: job.id } } })
      await this.stop(tx, job, 'FAILED', code, at)
      await this.audit(tx, job, f, 'booking.supplier.cancel_failed', { code })
    })
  }

  // ---- STATUS CHECK -----------------------------------------------------------------------------------------------------
  private async sync(job: Claimed, f: Facts, adapter: BookingSupplierPort, ctx: { tenantId: string; requestId: string }, now: () => Date): Promise<void> {
    const started = Date.now()
    let seen: BookingSupplierStatus
    try { seen = await adapter.statusByReference(ctx, { reference: f.reference, supplierKey: f.supplier }) } catch (error) {
      const failure = error instanceof BookingSupplierCallError ? error : new BookingSupplierCallError('error', 'SUPPLIER_ERROR')
      await this.logCall(job, f, 'STATUS_CHECK', failure.kind === 'timeout' ? 'TIMEOUT' : 'ERROR', { errorCode: failure.code, httpStatus: failure.httpStatus, durationMs: Date.now() - started })
      return this.markUnknown(job, f, failure.code, now())
    }
    await this.logCall(job, f, 'STATUS_CHECK', seen.found ? `FOUND_${seen.state}` : 'NOT_FOUND', { durationMs: Date.now() - started, supplierRef: seen.found ? seen.supplierRef : null })
    if (!seen.found) {
      if (f.status === 'PENDING_SUPPLIER') return this.noteNotFound(job, f, now()) // definitive: the supplier holds nothing, so "Send to supplier" is now safe
      return this.markUnknown(job, f, 'NOT_FOUND_AT_SUPPLIER', now())
    }
    if (f.status === 'PENDING_SUPPLIER') {
      if (seen.state === 'CONFIRMED' || seen.state === 'ON_REQUEST') return this.applyBooked(job, f, { outcome: seen.state, supplierRef: seen.supplierRef, hotelConfirmationNo: seen.hotelConfirmationNo }, seen.state, now())
      if (seen.state === 'REJECTED') return this.failBooking(job, f, 'Supplier reports the booking was rejected', 'REJECTED', now())
    }
    if (f.status === 'ON_REQUEST') {
      if (seen.state === 'CONFIRMED') return this.move(job, f, 'systemConfirmOnRequest', { supplierRef: seen.supplierRef ?? undefined, hotelConfirmationNo: seen.hotelConfirmationNo ?? undefined, supplierStatus: 'CONFIRMED' }, 'SUCCEEDED', null, now())
      if (seen.state === 'REJECTED') return this.move(job, f, 'systemRejectOnRequest', { reason: 'Supplier declined the on-request booking', supplierStatus: 'REJECTED' }, 'SUCCEEDED', null, now())
    }
    if (f.status === 'CANCEL_REQUESTED' && seen.state === 'CANCELLED') return this.move(job, f, 'systemCompleteCancellation', { supplierCancellationRef: seen.supplierCancellationRef ?? undefined, supplierStatus: 'CANCELLED' }, 'SUCCEEDED', null, now())
    // The supplier answered but nothing about the booking changes (still on request, still confirmed there while we wait to cancel...).
    await this.db.withTenantWrite(job.tenantId, async (tx) => {
      await tx.booking.updateMany({ where: { id: f.id, tenantId: job.tenantId, closedAt: null }, data: { supplierStatus: seen.found ? seen.state : null } })
      await this.stop(tx, job, 'SUCCEEDED', null, now())
    })
  }

  private async noteNotFound(job: Claimed, f: Facts, at: Date): Promise<void> {
    await this.db.withTenantWrite(job.tenantId, async (tx) => {
      await tx.booking.updateMany({ where: { id: f.id, tenantId: job.tenantId, closedAt: null }, data: { supplierStatus: 'NOT_FOUND' } })
      await tx.bookingEvent.create({ data: { tenantId: job.tenantId, bookingId: f.id, fromStatus: f.status, toStatus: f.status, actorType: 'SUPPLIER', action: 'supplierNotFound', payload: { jobId: job.id } } })
      await this.stop(tx, job, 'SUCCEEDED', null, at)
    })
  }

  // ---- shared -----------------------------------------------------------------------------------------------------------
  /** Never throws on a failed lookup: null-like answers are the point. */
  private async statusOrNull(job: Claimed, f: Facts, adapter: BookingSupplierPort, ctx: { tenantId: string; requestId: string }): Promise<BookingSupplierStatus | 'INCONCLUSIVE'> {
    const started = Date.now()
    try {
      const seen = await adapter.statusByReference({ ...ctx, requestId: `${ctx.requestId}:status` }, { reference: f.reference, supplierKey: f.supplier })
      await this.logCall(job, f, 'STATUS_CHECK', seen.found ? `FOUND_${seen.state}` : 'NOT_FOUND', { durationMs: Date.now() - started, supplierRef: seen.found ? seen.supplierRef : null })
      return seen
    } catch (error) {
      const failure = error instanceof BookingSupplierCallError ? error : new BookingSupplierCallError('error', 'SUPPLIER_ERROR')
      await this.logCall(job, f, 'STATUS_CHECK', failure.kind === 'timeout' ? 'TIMEOUT' : 'ERROR', { errorCode: failure.code, httpStatus: failure.httpStatus, durationMs: Date.now() - started })
      return 'INCONCLUSIVE'
    }
  }

  /** Records the supplier's answer through `transitionBooking`, finishes the job and writes the audit event, all in one transaction. */
  private async move(job: Claimed, f: Facts, action: BookingAction, fields: { supplierRef?: string; hotelConfirmationNo?: string; supplierCancellationRef?: string; reason?: string; supplierStatus: string }, jobStatus: 'SUCCEEDED', code: string | null, at: Date): Promise<void> {
    await this.db.withTenantWrite(job.tenantId, async (tx) => {
      const out = await transitionBooking(tx, { tenantId: job.tenantId, bookingId: f.id, action, expectedStatus: f.status, actor: { type: 'SUPPLIER' }, level: 'SYSTEM', now: at, idempotencyKey: `job:${job.id}:${job.attempt}:${action}`, emitFinance: true, ...fields })
      await this.stop(tx, job, jobStatus, code, at)
      if (!out.replayed) await this.audit(tx, job, f, `booking.${action}`, { from: f.status, to: out.status, jobId: job.id, attempt: job.attempt })
    })
  }

  private async markUnknown(job: Claimed, f: Facts, code: string, at: Date): Promise<void> {
    await this.db.withTenantWrite(job.tenantId, async (tx) => {
      await tx.booking.updateMany({ where: { id: f.id, tenantId: job.tenantId, closedAt: null }, data: { supplierStatus: 'UNKNOWN' } })
      await tx.bookingEvent.create({ data: { tenantId: job.tenantId, bookingId: f.id, fromStatus: f.status, toStatus: f.status, actorType: 'SUPPLIER', action: 'supplierUnknown', payload: { code, jobId: job.id } } })
      await this.stop(tx, job, 'UNKNOWN', code, at)
      await this.audit(tx, job, f, 'booking.supplier.outcome_unknown', { code, jobId: job.id })
    })
  }

  /** Another attempt after the spec's wait, or, when attempts are spent, the final state. `final` says what exhaustion means. */
  private async retryOrStop(job: Claimed, code: string, at: Date, final: 'FAILED' | 'UNKNOWN', f?: Facts, cancelling = false): Promise<void> {
    if (job.attempt < BOOKING_SUPPLIER_MAX_ATTEMPTS) {
      const wait = BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS[job.attempt - 1] ?? BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS.at(-1)!
      await this.db.withTenantWrite(job.tenantId, (tx) => tx.bookingSupplierJob.updateMany({ where: { id: job.id, tenantId: job.tenantId }, data: { status: 'RETRY_WAIT', runAfter: new Date(at.getTime() + wait * 1000), lockedUntil: null, lastErrorCode: code } }))
      return
    }
    if (final === 'FAILED' && f) {
      if (cancelling) return this.cancelFailed(job, f, code, at)
      // Attempts spent AND the supplier says it holds nothing under our reference: only now is the booking Failed.
      return this.failBooking(job, f, `The supplier did not answer after ${BOOKING_SUPPLIER_MAX_ATTEMPTS} attempts and holds no booking under our reference`, 'NO_ANSWER', at).then(() => undefined)
    }
    await this.db.withTenantWrite(job.tenantId, (tx) => this.stop(tx, job, 'UNKNOWN', code, at))
  }

  private async finish(job: Claimed, status: 'SUCCEEDED' | 'FAILED', code: string, at: Date): Promise<void> {
    await this.db.withTenantWrite(job.tenantId, (tx) => this.stop(tx, job, status, code, at))
  }

  private stop(tx: Tx, job: Claimed, status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN', code: string | null, at: Date) {
    return tx.bookingSupplierJob.updateMany({ where: { id: job.id, tenantId: job.tenantId }, data: { status, lockedUntil: null, lastErrorCode: code, completedAt: status === 'UNKNOWN' ? null : at } })
  }

  private async audit(tx: Tx, job: Claimed, f: Facts, action: string, payload: Record<string, unknown>): Promise<void> {
    // Attributed to the person who queued the work; a deleted user leaves the immutable BookingEvent as the record.
    if (!job.requestedByUserId) return
    await tx.auditEvent.createMany({ data: [{ tenantId: job.tenantId, userId: job.requestedByUserId, actorType: 'USER', action, entityType: 'booking', entityId: f.id, payload: { ...payload, via: 'supplier_job' } as Prisma.InputJsonValue }] })
  }

  /** One row per call: outcome, attempt, duration, error code, supplier reference. Never a request or a response. */
  private async logCall(job: Claimed, f: Facts, action: BookingSupplierJobKind, outcome: string, extra: { errorCode?: string | null; httpStatus?: number | null; durationMs?: number; supplierRef?: string | null }): Promise<void> {
    await this.db.withTenantWrite(job.tenantId, (tx) => tx.bookingSupplierCall.create({ data: { tenantId: job.tenantId, bookingId: f.id, jobId: job.id, action, attempt: job.attempt, supplierKey: f.supplier.slice(0, 64), outcome: outcome.slice(0, 48), errorCode: extra.errorCode?.slice(0, 64) ?? null, httpStatus: extra.httpStatus ?? null, durationMs: extra.durationMs ?? null, supplierReference: extra.supplierRef?.slice(0, 64) ?? null }, select: { id: true } }))
  }
}
