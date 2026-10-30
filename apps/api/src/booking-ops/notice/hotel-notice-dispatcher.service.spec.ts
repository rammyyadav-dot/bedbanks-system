import { EmailSendError, type EmailSender } from '../email/email-sender.port'
import { HOTEL_NOTICE_RETRY_DELAYS_SECONDS, HotelNoticeDispatcher } from './hotel-notice-dispatcher.service'

const T = 'tenant_1'
const NOW = new Date('2026-10-30T10:00:00Z')
const env = { HOTEL_NOTICE_DISPATCH_ENABLED: 'true', EMAIL_FROM: 'ops@fbeds.example' }

interface Row { id: string; tenantId: string; bookingId: string; kind?: string; copyAddresses?: string[]; toAddress: string | null; status: string; attempt: number; maxAttempts: number; runAfter: Date; lockedUntil: Date | null; lastErrorCode: string | null; sentAt?: Date; providerMessageId?: string | null; requestedByUserId: string | null }
const row = (extra: Partial<Row> = {}): Row => ({ id: 'n1', tenantId: T, bookingId: 'b1', kind: 'NEW', copyAddresses: ['agent@agency.test', 'admin@fbeds.test'], toAddress: 'res@atlas.ae', status: 'QUEUED', attempt: 0, maxAttempts: 5, runAfter: NOW, lockedUntil: null, lastErrorCode: null, requestedByUserId: 'u1', ...extra })
const booking = (extra = {}) => ({ status: 'CONFIRMED', reference: 'FB-0123456789ABCDEF0123', hotelId: 'h1', createdAt: NOW, checkIn: new Date('2026-12-01'), checkOut: new Date('2026-12-04'), hotelConfirmationNo: null, specialRequests: null,
  rooms: [{ position: 1, roomName: 'Deluxe', boardCode: 'BB', adults: 2, childAges: [] }], guests: [{ firstName: 'Amal', lastName: 'Haddad', isLead: true }], ...extra })

function harness(rows: Row[], opts: { booking?: unknown; voucher?: unknown; first?: unknown; send?: EmailSender['send'] } = {}) {
  const audit: Array<Record<string, any>> = []
  const tx = {
    $queryRaw: async () => rows.filter((r) => ['QUEUED', 'RETRY_WAIT'].includes(r.status) && r.runAfter <= NOW).map((r) => ({ id: r.id })),
    hotelNotice: {
      findFirstOrThrow: async ({ where }: any) => ({ ...rows.find((r) => r.id === where.id)! }),
      findFirst: async () => ('first' in opts ? opts.first : { status: 'SENT' }),
      update: async ({ where, data }: any) => { const r = rows.find((x) => x.id === where.id)!; for (const [k, v] of Object.entries(data)) (r as any)[k] = v && typeof v === 'object' && 'increment' in (v as object) ? (r as any)[k] + (v as any).increment : v },
    },
    booking: { findFirst: async () => ('booking' in opts ? opts.booking : booking()) },
    bookingDocument: { findFirst: async () => ('voucher' in opts ? opts.voucher : { payload: { hotel: { name: 'Atlas Hotel' } } }) },
    auditEvent: { createMany: async ({ data }: any) => { audit.push(...data) } },
  }
  const sent: Array<{ to: string[]; bcc?: string[]; raw: string }> = []
  const sender: EmailSender = { name: 'test', configured: () => true, send: opts.send ?? (async (envelope, raw) => { sent.push({ to: envelope.to, bcc: envelope.bcc, raw }); return { messageId: 'm-1' } }) }
  const db: any = { configured: () => true, hotelNoticeDueTenants: async () => (rows.some((r) => ['QUEUED', 'RETRY_WAIT'].includes(r.status)) ? [T] : []), withTenantWrite: async (_t: string, cb: any) => cb(tx) }
  return { dispatcher: new HotelNoticeDispatcher(db, sender, env), sent, audit, rows }
}

/** The decoded Subject header of a raw MIME message (RFC 2047 base64 words when non-ASCII). */
const subjectOf = (raw: string) => { const line = raw.split('\r\n').find((l) => l.startsWith('Subject: '))!.slice(9); const w = line.match(/^=\?UTF-8\?B\?(.+)\?=$/); return w ? Buffer.from(w[1], 'base64').toString('utf8') : line }

describe('HotelNoticeDispatcher', () => {
  it('stays off unless enabled, and refuses to start without its own database credential or sender', () => {
    const off = harness([row()]); expect(() => new HotelNoticeDispatcher({ configured: () => true } as any, { configured: () => true } as any, {}).onModuleInit()).not.toThrow(); void off
    expect(() => new HotelNoticeDispatcher({ configured: () => false } as any, { configured: () => true } as any, env).onModuleInit()).toThrow('BOOKING_OPS_DATABASE_URL')
    expect(() => new HotelNoticeDispatcher({ configured: () => true } as any, { configured: () => false } as any, env).onModuleInit()).toThrow('EMAIL_FROM')
  })

  it('sends the notice to the snapshotted hotel address, marks it SENT and audits codes only', async () => {
    const h = harness([row()])
    expect(await h.dispatcher.runOnce(() => NOW)).toBe(1)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].to).toEqual(['res@atlas.ae'])
    expect(h.rows[0]).toMatchObject({ status: 'SENT', attempt: 1, providerMessageId: 'm-1', lockedUntil: null })
    expect(h.audit).toEqual([expect.objectContaining({ action: 'booking.hotel_notice.sent', payload: { kind: 'NEW', attempt: 1, via: 'email_dispatch', copies: 2 } })])
    expect(JSON.stringify(h.audit)).not.toMatch(/Amal|Haddad|res@atlas/)
  })

  it('a transient provider failure waits and retries; the fifth failure is final', async () => {
    const fail = async () => { throw new EmailSendError('THROTTLED', false) }
    const h = harness([row()], { send: fail })
    await h.dispatcher.runOnce(() => NOW)
    expect(h.rows[0]).toMatchObject({ status: 'RETRY_WAIT', attempt: 1, lastErrorCode: 'THROTTLED', runAfter: new Date(NOW.getTime() + HOTEL_NOTICE_RETRY_DELAYS_SECONDS[0] * 1000) })
    const last = harness([row({ attempt: 4 })], { send: fail })
    await last.dispatcher.runOnce(() => NOW)
    expect(last.rows[0]).toMatchObject({ status: 'FAILED', attempt: 5, lastErrorCode: 'THROTTLED' })
  })

  it('a permanent rejection is final at once', async () => {
    const h = harness([row()], { send: async () => { throw new EmailSendError('ADDRESS_REJECTED', true) } })
    await h.dispatcher.runOnce(() => NOW)
    expect(h.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'ADDRESS_REJECTED' })
  })

  it('does not announce a booking that is no longer confirmed, and sends nothing', async () => {
    const h = harness([row()], { booking: booking({ status: 'CANCELLED' }) })
    await h.dispatcher.runOnce(() => NOW)
    expect(h.sent).toHaveLength(0)
    expect(h.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'BOOKING_NOT_CONFIRMED' })
  })

  it('waits for the voucher (hotel name) and stops on a notice that can never be valid', async () => {
    const waiting = harness([row()], { voucher: null })
    await waiting.dispatcher.runOnce(() => NOW)
    expect(waiting.rows[0]).toMatchObject({ status: 'RETRY_WAIT', lastErrorCode: 'DOCUMENTS_PENDING' })
    const invalid = harness([row()], { booking: booking({ guests: [] }) })
    await invalid.dispatcher.runOnce(() => NOW)
    expect(invalid.sent).toHaveLength(0)
    expect(invalid.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'NOTICE_INVALID' })
  })

  it('never resends a row whose last attempt was lost, and never sends a row with no recipient', async () => {
    const lost = harness([row({ attempt: 5 })])
    await lost.dispatcher.runOnce(() => NOW)
    expect(lost.sent).toHaveLength(0)
    expect(lost.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'DISPATCHER_LOST' })
    const none = harness([row({ toAddress: null })])
    await none.dispatcher.runOnce(() => NOW)
    expect(none.sent).toHaveLength(0)
    expect(none.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'NO_RESERVATIONS_EMAIL' })
  })

  it('blind-copies the travel agent and admin: they are not in the headers, and the hotel address is not a copy', async () => {
    const h = harness([row()])
    await h.dispatcher.runOnce(() => NOW)
    expect(h.sent[0].to).toEqual(['res@atlas.ae'])
    expect(h.sent[0].bcc).toEqual(['agent@agency.test', 'admin@fbeds.test'])
    expect(h.sent[0].raw).not.toMatch(/agent@agency\.test|admin@fbeds\.test/i) // BCC: never in the message headers
    expect(h.audit[0].payload).toMatchObject({ kind: 'NEW', copies: 2 })
  })

  it('sends a cancellation to a hotel that was told, saying so in the subject, only while the booking is cancelled', async () => {
    const ok = harness([row({ kind: 'CANCEL' })], { booking: booking({ status: 'CANCELLED' }) })
    await ok.dispatcher.runOnce(() => NOW)
    expect(ok.rows[0].status).toBe('SENT')
    expect(subjectOf(ok.sent[0].raw)).toMatch(/^Reservation cancelled · FB-0123456789ABCDEF0123/)
    expect(ok.audit[0].payload).toMatchObject({ kind: 'CANCEL' })
    const notCancelled = harness([row({ kind: 'CANCEL' })], { booking: booking({ status: 'CONFIRMED' }) })
    await notCancelled.dispatcher.runOnce(() => NOW)
    expect(notCancelled.sent).toHaveLength(0)
    expect(notCancelled.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'BOOKING_NOT_CANCELLED' })
  })

  it('an amendment goes only while the booking is confirmed; a cancelled booking is not amended', async () => {
    const ok = harness([row({ kind: 'AMEND' })])
    await ok.dispatcher.runOnce(() => NOW)
    expect(ok.rows[0].status).toBe('SENT')
    const gone = harness([row({ kind: 'AMEND' })], { booking: booking({ status: 'CANCELLED' }) })
    await gone.dispatcher.runOnce(() => NOW)
    expect(gone.sent).toHaveLength(0)
    expect(gone.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'BOOKING_NOT_CONFIRMED' })
  })

  it('never tells a hotel about a change to a booking it was never told about: waits for the original, stops if it failed', async () => {
    for (const kind of ['AMEND', 'CANCEL']) {
      const status = kind === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'
      const waiting = harness([row({ kind })], { booking: booking({ status }), first: { status: 'RETRY_WAIT' } })
      await waiting.dispatcher.runOnce(() => NOW)
      expect(waiting.sent).toHaveLength(0)
      expect(waiting.rows[0]).toMatchObject({ status: 'RETRY_WAIT', lastErrorCode: 'WAITING_FOR_NEW_NOTICE' })
      const never = harness([row({ kind })], { booking: booking({ status }), first: { status: 'FAILED' } })
      await never.dispatcher.runOnce(() => NOW)
      expect(never.sent).toHaveLength(0)
      expect(never.rows[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'HOTEL_NEVER_NOTIFIED' })
    }
  })
})
