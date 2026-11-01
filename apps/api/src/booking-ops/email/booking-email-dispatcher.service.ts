import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { BookingOpsDatabase } from '../booking-ops-database'
import { renderConfirmationEmail } from './booking-email.render'
import { EMAIL_SENDER, EmailSendError, type EmailSender } from './email-sender.port'
import { buildMime } from './mime'

const BATCH = 10
const LOCK_SECONDS = 120
const MIN_INTERVAL_MS = 1_000
const DEFAULT_INTERVAL_MS = 30_000
/** Waits before attempts 2..5. The fifth failure is final. */
export const BOOKING_EMAIL_RETRY_DELAYS_SECONDS = [60, 300, 900, 3600] as const
const FROM = /^(?:[^<>\r\n]{1,64} <)?[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}>?$/

interface Claimed { id: string; tenantId: string; bookingId: string; attempt: number; maxAttempts: number; to: string; cc: string[]; requestedByUserId: string | null }

/**
 * Sends the booking confirmation outbox (ADR 0066). Off unless `EMAIL_DISPATCH_ENABLED=true`; then it needs the booking module's own database
 * credential and a configured sender (`EMAIL_FROM`, `EMAIL_SES_REGION`). The provider call happens outside any database transaction.
 * Logs and audit events carry codes only, never an address, a guest name or the message.
 */
@Injectable()
export class BookingEmailDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingEmailDispatcher.name)
  private timer?: NodeJS.Timeout
  private running = false

  constructor(private readonly db: BookingOpsDatabase, @Inject(EMAIL_SENDER) private readonly sender: EmailSender, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  onModuleInit(): void {
    if (this.env.EMAIL_DISPATCH_ENABLED !== 'true') return
    if (!this.db.configured()) throw new Error('EMAIL_DISPATCH_ENABLED requires BOOKING_OPS_DATABASE_URL (a different credential from DATABASE_URL)')
    if (!this.sender.configured()) throw new Error('EMAIL_DISPATCH_ENABLED requires EMAIL_FROM and EMAIL_SES_REGION')
    if (!FROM.test(this.env.EMAIL_FROM!.trim())) throw new Error('EMAIL_FROM must be an address or "Name <address>"')
    const interval = Number(this.env.EMAIL_DISPATCH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`EMAIL_DISPATCH_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Booking email dispatcher enabled every ${interval}ms via ${this.sender.name}`)
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass over every tenant with a due email. Never overlaps itself. Returns the number of emails processed. */
  async runOnce(now: () => Date = () => new Date()): Promise<number> {
    if (this.running) return 0
    this.running = true
    let processed = 0
    try {
      for (const tenantId of await this.db.emailDueTenants(now())) {
        try {
          for (const email of await this.claim(tenantId, now())) { await this.process(email, now); processed += 1 }
        } catch (error) { this.logger.error(`Booking emails failed for a tenant: ${error instanceof Error ? error.name : 'unknown error'}`) }
      }
    } catch (error) { this.logger.error(`Email dispatcher could not list due tenants: ${error instanceof Error ? error.name : 'unknown error'}`) } finally { this.running = false }
    return processed
  }

  /** Marks due rows SENDING with a lock and counts the attempt. SKIP LOCKED lets two dispatchers share the table without taking the same row. */
  private claim(tenantId: string, now: Date): Promise<Claimed[]> {
    return this.db.withTenantWrite(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BookingEmail" WHERE "tenant_id" = ${tenantId} AND (("status" IN ('QUEUED','RETRY_WAIT') AND "run_after" <= ${now}) OR ("status" = 'SENDING' AND "locked_until" IS NOT NULL AND "locked_until" <= ${now})) ORDER BY "run_after" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`
      const out: Claimed[] = []
      for (const { id } of rows) {
        const email = await tx.bookingEmail.findFirstOrThrow({ where: { id, tenantId } })
        if (email.attempt >= email.maxAttempts) {
          // A dispatcher died during the last attempt; the provider may or may not have accepted it. Stop rather than risk a duplicate.
          await tx.bookingEmail.update({ where: { id, tenantId }, data: { status: 'FAILED', lockedUntil: null, lastErrorCode: 'DISPATCHER_LOST' } })
          continue
        }
        await tx.bookingEmail.update({ where: { id, tenantId }, data: { status: 'SENDING', attempt: { increment: 1 }, lockedUntil: new Date(now.getTime() + LOCK_SECONDS * 1000) } })
        out.push({ id, tenantId, bookingId: email.bookingId, attempt: email.attempt + 1, maxAttempts: email.maxAttempts, to: email.toAddress, cc: email.ccAddresses, requestedByUserId: email.requestedByUserId })
      }
      return out
    })
  }

  private async process(email: Claimed, now: () => Date): Promise<void> {
    let message: ReturnType<typeof renderConfirmationEmail>
    try {
      const facts = await this.db.withTenantWrite(email.tenantId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: email.bookingId, tenantId: email.tenantId }, select: { status: true } })
        const docs = await tx.bookingDocument.findMany({ where: { bookingId: email.bookingId, tenantId: email.tenantId, type: { in: ['VOUCHER', 'INVOICE'] } }, select: { type: true, number: true, issuedAt: true, payload: true } })
        return { booking, voucher: docs.find((d) => d.type === 'VOUCHER'), invoice: docs.find((d) => d.type === 'INVOICE') }
      })
      if (!facts.booking) return this.finish(email, 'FAILED', 'BOOKING_NOT_FOUND', now())
      // A booking cancelled before its confirmation went out must not be announced as confirmed.
      if (facts.booking.status !== 'CONFIRMED') return this.finish(email, 'FAILED', 'BOOKING_NOT_CONFIRMED', now())
      if (!facts.voucher || !facts.invoice) return this.retryOrStop(email, 'DOCUMENTS_PENDING', now())
      const doc = (d: NonNullable<typeof facts.voucher>) => ({ number: d.number, issuedAt: d.issuedAt.toISOString(), payload: d.payload as Record<string, any> })
      message = renderConfirmationEmail({ voucher: doc(facts.voucher), invoice: doc(facts.invoice), bookingStatus: facts.booking.status, portalUrl: this.env.AGENT_PORTAL_URL })
    } catch (error) {
      this.logger.error(`Booking email ${email.id} could not be prepared: ${error instanceof Error ? error.name : 'unknown error'}`)
      return this.retryOrStop(email, 'PREPARE_ERROR', now())
    }
    const from = this.env.EMAIL_FROM!.trim()
    let messageId: string
    try {
      const raw = buildMime({ from, to: [email.to], cc: email.cc, ...message })
      messageId = (await this.sender.send({ from, to: [email.to], cc: email.cc }, raw)).messageId
    } catch (error) {
      const failure = error instanceof EmailSendError ? error : new EmailSendError('SEND_ERROR', false)
      this.logger.warn(`Booking email ${email.id} attempt ${email.attempt} failed: ${failure.code}`)
      if (failure.permanent) return this.finish(email, 'FAILED', failure.code, now())
      return this.retryOrStop(email, failure.code, now())
    }
    // Recorded outside the send's error handling: once the provider accepted the message, a bookkeeping failure must never turn into a resend.
    // If it fails, the row stays SENDING under its lock and the error surfaces; it is reclaimed only after the lock expires.
    await this.finish(email, 'SENT', null, now(), messageId)
  }

  private retryOrStop(email: Claimed, code: string, at: Date): Promise<void> {
    if (email.attempt >= email.maxAttempts) return this.finish(email, 'FAILED', code, at)
    const delay = BOOKING_EMAIL_RETRY_DELAYS_SECONDS[Math.min(email.attempt - 1, BOOKING_EMAIL_RETRY_DELAYS_SECONDS.length - 1)]
    return this.db.withTenantWrite(email.tenantId, async (tx) => {
      await tx.bookingEmail.update({ where: { id: email.id, tenantId: email.tenantId }, data: { status: 'RETRY_WAIT', lockedUntil: null, lastErrorCode: code, runAfter: new Date(at.getTime() + delay * 1000) } })
    })
  }

  private finish(email: Claimed, status: 'SENT' | 'FAILED', code: string | null, at: Date, messageId?: string): Promise<void> {
    return this.db.withTenantWrite(email.tenantId, async (tx) => {
      await tx.bookingEmail.update({ where: { id: email.id, tenantId: email.tenantId }, data: { status, lockedUntil: null, lastErrorCode: code, ...(status === 'SENT' ? { sentAt: at, providerMessageId: messageId ?? null } : {}) } })
      // createMany: the audit log is write-only for this role (no RETURNING, so no SELECT is needed). Attributed to the agent whose confirmation
      // queued the email, like the supplier runner's job events (the policy keeps SYSTEM inserts for named roles only).
      await tx.auditEvent.createMany({ data: [{ tenantId: email.tenantId, userId: email.requestedByUserId, actorType: 'USER', action: status === 'SENT' ? 'booking.email.sent' : 'booking.email.failed', entityType: 'booking', entityId: email.bookingId,
        payload: { kind: 'BOOKING_CONFIRMATION', attempt: email.attempt, via: 'email_dispatch', ...(code ? { code } : {}) } }] })
    })
  }
}
