import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { HotelNoticeInvalid } from '@bedbanks/connectors-core'
import { BookingOpsDatabase } from '../booking-ops-database'
import { EMAIL_SENDER, EmailSendError, type EmailSender } from '../email/email-sender.port'
import { buildMime } from '../email/mime'
import { buildHotelNotice } from './hotel-notice-facts'
import { renderHotelNoticeEmail } from './hotel-notice-email.render'

const BATCH = 10
const LOCK_SECONDS = 120
const MIN_INTERVAL_MS = 1_000
const DEFAULT_INTERVAL_MS = 30_000
/** Waits before attempts 2..5. The fifth failure is final. */
export const HOTEL_NOTICE_RETRY_DELAYS_SECONDS = [60, 300, 900, 3600] as const
const FROM = /^(?:[^<>\r\n]{1,64} <)?[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}>?$/

interface Claimed { id: string; tenantId: string; bookingId: string; attempt: number; maxAttempts: number; to: string; requestedByUserId: string | null }

/**
 * Sends the hotel reservation notice outbox (ADR 0106), to the address snapshotted from the hotel profile. Off unless `HOTEL_NOTICE_DISPATCH_ENABLED=true`; then it needs
 * the booking module's own database credential and the same configured sender as the confirmation email (`EMAIL_FROM`, `EMAIL_SES_REGION`). The provider call happens
 * outside any database transaction. Logs and audit events carry codes only, never an address, a guest name or the message.
 */
@Injectable()
export class HotelNoticeDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HotelNoticeDispatcher.name)
  private timer?: NodeJS.Timeout
  private running = false

  constructor(private readonly db: BookingOpsDatabase, @Inject(EMAIL_SENDER) private readonly sender: EmailSender, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  onModuleInit(): void {
    if (this.env.HOTEL_NOTICE_DISPATCH_ENABLED !== 'true') return
    if (!this.db.configured()) throw new Error('HOTEL_NOTICE_DISPATCH_ENABLED requires BOOKING_OPS_DATABASE_URL (a different credential from DATABASE_URL)')
    if (!this.sender.configured()) throw new Error('HOTEL_NOTICE_DISPATCH_ENABLED requires EMAIL_FROM and EMAIL_SES_REGION')
    if (!FROM.test(this.env.EMAIL_FROM!.trim())) throw new Error('EMAIL_FROM must be an address or "Name <address>"')
    const interval = Number(this.env.HOTEL_NOTICE_DISPATCH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`HOTEL_NOTICE_DISPATCH_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Hotel notice dispatcher enabled every ${interval}ms via ${this.sender.name}`)
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass over every tenant with a due notice. Never overlaps itself. Returns the number of notices processed. */
  async runOnce(now: () => Date = () => new Date()): Promise<number> {
    if (this.running) return 0
    this.running = true
    let processed = 0
    try {
      for (const tenantId of await this.db.hotelNoticeDueTenants(now())) {
        try {
          for (const notice of await this.claim(tenantId, now())) { await this.process(notice, now); processed += 1 }
        } catch (error) { this.logger.error(`Hotel notices failed for a tenant: ${error instanceof Error ? error.name : 'unknown error'}`) }
      }
    } catch (error) { this.logger.error(`Hotel notice dispatcher could not list due tenants: ${error instanceof Error ? error.name : 'unknown error'}`) } finally { this.running = false }
    return processed
  }

  /** Marks due rows SENDING with a lock and counts the attempt. SKIP LOCKED lets two dispatchers share the table without taking the same row. */
  private claim(tenantId: string, now: Date): Promise<Claimed[]> {
    return this.db.withTenantWrite(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "HotelNotice" WHERE "tenant_id" = ${tenantId} AND (("status" IN ('QUEUED','RETRY_WAIT') AND "run_after" <= ${now}) OR ("status" = 'SENDING' AND "locked_until" IS NOT NULL AND "locked_until" <= ${now})) ORDER BY "run_after" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`
      const out: Claimed[] = []
      for (const { id } of rows) {
        const row = await tx.hotelNotice.findFirstOrThrow({ where: { id, tenantId } })
        if (row.attempt >= row.maxAttempts || !row.toAddress) {
          // A dispatcher died during the last attempt (the provider may or may not have accepted it), or the row has no recipient. Stop rather than risk a duplicate.
          await tx.hotelNotice.update({ where: { id, tenantId }, data: { status: 'FAILED', lockedUntil: null, lastErrorCode: row.toAddress ? 'DISPATCHER_LOST' : 'NO_RESERVATIONS_EMAIL' } })
          continue
        }
        await tx.hotelNotice.update({ where: { id, tenantId }, data: { status: 'SENDING', attempt: { increment: 1 }, lockedUntil: new Date(now.getTime() + LOCK_SECONDS * 1000) } })
        out.push({ id, tenantId, bookingId: row.bookingId, attempt: row.attempt + 1, maxAttempts: row.maxAttempts, to: row.toAddress, requestedByUserId: row.requestedByUserId })
      }
      return out
    })
  }

  private async process(notice: Claimed, now: () => Date): Promise<void> {
    let message: ReturnType<typeof renderHotelNoticeEmail>
    try {
      const facts = await this.db.withTenantWrite(notice.tenantId, async (tx) => {
        const booking = await tx.booking.findFirst({ where: { id: notice.bookingId, tenantId: notice.tenantId }, select: { status: true, reference: true, hotelId: true, createdAt: true, checkIn: true, checkOut: true, hotelConfirmationNo: true, specialRequests: true,
          rooms: { select: { position: true, roomName: true, boardCode: true, adults: true, childAges: true } }, guests: { select: { firstName: true, lastName: true, isLead: true } } } })
        const voucher = await tx.bookingDocument.findFirst({ where: { bookingId: notice.bookingId, tenantId: notice.tenantId, type: 'VOUCHER' }, select: { payload: true } })
        return { booking, voucher }
      })
      if (!facts.booking) return this.finish(notice, 'FAILED', 'BOOKING_NOT_FOUND', now())
      // A booking cancelled before its notice went out must not be announced to the hotel as new.
      if (facts.booking.status !== 'CONFIRMED') return this.finish(notice, 'FAILED', 'BOOKING_NOT_CONFIRMED', now())
      const hotelName = (facts.voucher?.payload as { hotel?: { name?: unknown } } | null)?.hotel?.name
      if (typeof hotelName !== 'string' || !hotelName.trim()) return this.retryOrStop(notice, 'DOCUMENTS_PENDING', now())
      message = renderHotelNoticeEmail(buildHotelNotice('NEW', facts.booking), hotelName.trim())
    } catch (error) {
      // An invalid notice (for example a booking with no guests) will not become valid by waiting: stop and let Operations see the code.
      if (error instanceof HotelNoticeInvalid) { this.logger.error(`Hotel notice ${notice.id} is invalid (${error.field})`); return this.finish(notice, 'FAILED', 'NOTICE_INVALID', now()) }
      this.logger.error(`Hotel notice ${notice.id} could not be prepared: ${error instanceof Error ? error.name : 'unknown error'}`)
      return this.retryOrStop(notice, 'PREPARE_ERROR', now())
    }
    const from = this.env.EMAIL_FROM!.trim()
    let messageId: string
    try {
      const raw = buildMime({ from, to: [notice.to], cc: [], ...message, attachments: [] })
      messageId = (await this.sender.send({ from, to: [notice.to], cc: [] }, raw)).messageId
    } catch (error) {
      const failure = error instanceof EmailSendError ? error : new EmailSendError('SEND_ERROR', false)
      this.logger.warn(`Hotel notice ${notice.id} attempt ${notice.attempt} failed: ${failure.code}`)
      if (failure.permanent) return this.finish(notice, 'FAILED', failure.code, now())
      return this.retryOrStop(notice, failure.code, now())
    }
    // Recorded outside the send's error handling: once the provider accepted the message, a bookkeeping failure must never turn into a resend.
    await this.finish(notice, 'SENT', null, now(), messageId)
  }

  private retryOrStop(notice: Claimed, code: string, at: Date): Promise<void> {
    if (notice.attempt >= notice.maxAttempts) return this.finish(notice, 'FAILED', code, at)
    const delay = HOTEL_NOTICE_RETRY_DELAYS_SECONDS[Math.min(notice.attempt - 1, HOTEL_NOTICE_RETRY_DELAYS_SECONDS.length - 1)]
    return this.db.withTenantWrite(notice.tenantId, async (tx) => {
      await tx.hotelNotice.update({ where: { id: notice.id, tenantId: notice.tenantId }, data: { status: 'RETRY_WAIT', lockedUntil: null, lastErrorCode: code, runAfter: new Date(at.getTime() + delay * 1000) } })
    })
  }

  private finish(notice: Claimed, status: 'SENT' | 'FAILED', code: string | null, at: Date, messageId?: string): Promise<void> {
    return this.db.withTenantWrite(notice.tenantId, async (tx) => {
      await tx.hotelNotice.update({ where: { id: notice.id, tenantId: notice.tenantId }, data: { status, lockedUntil: null, lastErrorCode: code, ...(status === 'SENT' ? { sentAt: at, providerMessageId: messageId ?? null } : {}) } })
      // createMany: the audit log is write-only for this role (no RETURNING, so no SELECT is needed). Attributed to the agent whose confirmation queued the notice.
      await tx.auditEvent.createMany({ data: [{ tenantId: notice.tenantId, userId: notice.requestedByUserId, actorType: 'USER', action: status === 'SENT' ? 'booking.hotel_notice.sent' : 'booking.hotel_notice.failed', entityType: 'booking', entityId: notice.bookingId,
        payload: { kind: 'NEW', attempt: notice.attempt, via: 'email_dispatch', ...(code ? { code } : {}) } }] })
    })
  }
}
