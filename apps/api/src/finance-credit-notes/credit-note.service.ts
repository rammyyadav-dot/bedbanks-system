import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BookingCreditNote } from '@prisma/client'
import { CREDIT_NOTE_FAILURE, CREDIT_NOTE_STATUSES, type BookingCreditNoteView, type CreditNoteReasonName, type CreditNoteStatusName, type Paged } from '@bedbanks/contracts'
import { refundWithin } from '@bedbanks/money'
import { PrismaService } from '../database/prisma.service'
import { appendLedgerEntry, referenceSumMinor } from '../ledger/ledger-core'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { enumParam, idParam, pageParams, paged } from '../admin-operations/query-params'
import { parseCreditNoteProposal, parseDecisionReason } from './credit-note-input'

/** Booking states a partial credit may be issued against: charged and not in any cancellation or amendment flow. A cancelled booking is credited by the cancellation settlement (ADR 0069). */
export const CREDITABLE_STATES: ReadonlySet<string> = new Set(['CONFIRMED', 'CHECKED_OUT', 'NO_SHOW'])

const refuse = (status: 400 | 403 | 404 | 409 | 503, message: string, code: string) => {
  const body = { message, code }
  if (status === 403) return new ForbiddenException(body)
  if (status === 404) return new NotFoundException(body)
  if (status === 409) return new ConflictException(body)
  if (status === 503) return new ServiceUnavailableException(body)
  return new BadRequestException(body)
}
const iso = (d: Date | null) => (d ? d.toISOString() : null)

type Row = BookingCreditNote & { booking: { reference: string } }

/**
 * Partial credit notes to agencies (ADR 0095 part B).
 *
 * Proposing records intent and moves no money. Approving, by a different person, posts exactly one REFUND to the agency account in the same transaction that marks the
 * note approved, under the booking row lock and the wallet row lock (the order every cancellation path uses). Idempotent: the REFUND is keyed `booking:<id>:credit-note:<noteId>`
 * and the note links its entry (unique). A credit can never exceed the charge not yet refunded, counting notes still waiting, so two proposals cannot over-credit together.
 * Runs on the API connection like the cancellation settlement, because the booking module's role has no ledger access (ADR 0032). Writes need CREDIT_NOTES_ENABLED=true.
 */
@Injectable()
export class CreditNoteService {
  constructor(private readonly prisma: PrismaService) {}

  private assertEnabled(env: NodeJS.ProcessEnv = process.env) {
    if (env.CREDIT_NOTES_ENABLED !== 'true') throw refuse(503, 'Credit notes are not enabled on this deployment.', CREDIT_NOTE_FAILURE.disabled)
  }

  private view(r: Row, me: string): BookingCreditNoteView {
    return {
      id: r.id, number: r.number, bookingId: r.bookingId, bookingReference: r.booking.reference, currency: r.currency, amountMinor: r.amountMinor.toString(), reason: r.reason as CreditNoteReasonName,
      note: r.note, status: r.status as CreditNoteStatusName, proposedById: r.proposedById, proposedAt: r.createdAt.toISOString(), decidedById: r.decidedById, decidedAt: iso(r.decidedAt),
      decisionReason: r.decisionReason, ledgerEntryId: r.ledgerEntryId, canDecide: r.status === 'PROPOSED' && r.proposedById !== me,
    }
  }

  async list(tenantId: string, me: string, query: Record<string, unknown>): Promise<Paged<BookingCreditNoteView>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, CREDIT_NOTE_STATUSES)
    const bookingId = idParam('bookingId', query.bookingId)
    const where: Prisma.BookingCreditNoteWhereInput = { tenantId, ...(status && { status }), ...(bookingId && { bookingId }) }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.bookingCreditNote.findMany({ where, include: { booking: { select: { reference: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.bookingCreditNote.count({ where }),
      ])
      return paged(rows.map((r) => this.view(r as Row, me)), page, total)
    })
  }

  /** Locks the booking, checks it can be credited and finds its ledger charge. Caller is inside a tenant transaction. */
  private async lockCreditable(tx: Prisma.TransactionClient, tenantId: string, bookingId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
    if (locked.length !== 1) throw refuse(404, 'Booking not found', CREDIT_NOTE_FAILURE.bookingNotFound)
    const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId }, select: { id: true, reference: true, status: true, currency: true } })
    if (!CREDITABLE_STATES.has(booking.status)) throw refuse(409, `A credit note can be issued only for a confirmed, checked-out or no-show booking (this one is ${booking.status}). Cancelled bookings are credited by the cancellation settlement.`, CREDIT_NOTE_FAILURE.bookingNotCreditable)
    const debit = await tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: `booking:${bookingId}:authorize:settle-debit`, type: 'DEBIT' } })
    if (!debit) throw refuse(409, 'This booking was not charged to an agency account on the ledger, so there is nothing to credit.', CREDIT_NOTE_FAILURE.notCharged)
    return { booking, debit, chargedMinor: -debit.amountMinor }
  }

  async propose(tenantId: string, userId: string, body: unknown): Promise<BookingCreditNoteView> {
    this.assertEnabled()
    const p = parseCreditNoteProposal(body)
    const include = { booking: { select: { reference: true } } } as const
    const replay = async () => {
      const existing = await this.prisma.withTenant(tenantId, (tx) => tx.bookingCreditNote.findFirst({ where: { tenantId, requestId: p.requestId }, include }))
      if (!existing) return null
      if (existing.bookingId !== p.bookingId || existing.amountMinor !== p.amountMinor || existing.reason !== p.reason) throw refuse(409, 'This requestId was already used for a different credit note', CREDIT_NOTE_FAILURE.requestReused)
      return this.view(existing as Row, userId)
    }
    const earlier = await replay()
    if (earlier) return earlier
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        const { booking, debit, chargedMinor } = await this.lockCreditable(tx, tenantId, p.bookingId)
        const reference = `booking:${booking.id}`
        const [refunded, waiting, last] = await Promise.all([
          referenceSumMinor(tx, tenantId, debit.walletId, reference, 'REFUND'),
          tx.bookingCreditNote.aggregate({ where: { tenantId, bookingId: booking.id, status: 'PROPOSED' }, _sum: { amountMinor: true } }),
          tx.bookingCreditNote.aggregate({ where: { tenantId, bookingId: booking.id }, _max: { seq: true } }),
        ])
        const refundable = chargedMinor - refunded - (waiting._sum.amountMinor ?? 0n)
        if (!refundWithin({ refundMinor: p.amountMinor, authorizedRefundableMinor: refundable < 0n ? 0n : refundable })) {
          throw refuse(409, 'The credit exceeds the part of the charge not yet refunded or already proposed for credit.', CREDIT_NOTE_FAILURE.exceedsRefundable)
        }
        const seq = (last._max.seq ?? 0) + 1
        const created = await tx.bookingCreditNote.create({
          data: { tenantId, bookingId: booking.id, seq, number: `CN-${booking.reference}-P${seq}`, currency: debit.currency, amountMinor: p.amountMinor, reason: p.reason, note: p.note, requestId: p.requestId, proposedById: userId },
          include,
        })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.credit_note.proposed', entityType: 'booking_credit_note', entityId: created.id, payload: sanitizeAuditPayload({
          bookingId: booking.id, number: created.number, reason: p.reason, currency: debit.currency, amountMinor: p.amountMinor.toString(), chargedMinor: chargedMinor.toString(), refundedMinor: refunded.toString(),
        }) } })
        return this.view(created as Row, userId)
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await replay()
        if (raced) return raced
      }
      throw error
    }
  }

  async approve(tenantId: string, userId: string, creditNoteId: string): Promise<BookingCreditNoteView> {
    this.assertEnabled()
    const id = idParam('creditNoteId', creditNoteId)
    if (!id) throw refuse(400, 'creditNoteId is required', CREDIT_NOTE_FAILURE.invalid)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const note = await tx.bookingCreditNote.findFirst({ where: { id, tenantId } })
      if (!note) throw refuse(404, 'Credit note not found', CREDIT_NOTE_FAILURE.notFound)
      if (note.status !== 'PROPOSED') throw refuse(409, 'This credit note is already decided', CREDIT_NOTE_FAILURE.decided)
      if (note.proposedById === userId) throw refuse(403, 'The person who proposed a credit note cannot approve it', CREDIT_NOTE_FAILURE.ownProposal)
      const { debit, chargedMinor } = await this.lockCreditable(tx, tenantId, note.bookingId)
      const wallet = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "id" = ${debit.walletId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (wallet.length !== 1) throw refuse(409, 'The agency account could not be locked', CREDIT_NOTE_FAILURE.changed)
      const reference = `booking:${note.bookingId}`
      const refunded = await referenceSumMinor(tx, tenantId, debit.walletId, reference, 'REFUND')
      // Other notes still waiting are not counted here: each is checked when its own turn comes, under the same locks.
      if (!refundWithin({ refundMinor: note.amountMinor, authorizedRefundableMinor: chargedMinor - refunded < 0n ? 0n : chargedMinor - refunded })) {
        throw refuse(409, 'The credit now exceeds the part of the charge not yet refunded (a cancellation or another credit was posted since it was proposed).', CREDIT_NOTE_FAILURE.exceedsRefundable)
      }
      const entry = await appendLedgerEntry(tx, { tenantId, walletId: debit.walletId, type: 'REFUND', amountMinor: note.amountMinor, currency: debit.currency, reference, idempotencyKey: `booking:${note.bookingId}:credit-note:${note.id}` })
      const moved = await tx.bookingCreditNote.updateMany({ where: { id, tenantId, status: 'PROPOSED' }, data: { status: 'APPROVED', decidedById: userId, decidedAt: new Date(), ledgerEntryId: entry.id } })
      if (moved.count !== 1) throw refuse(409, 'This credit note changed while you were deciding; reload it', CREDIT_NOTE_FAILURE.changed)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.credit_note.approved', entityType: 'booking_credit_note', entityId: id, payload: sanitizeAuditPayload({
        bookingId: note.bookingId, number: note.number, reason: note.reason, currency: debit.currency, amountMinor: note.amountMinor.toString(), walletId: debit.walletId, ledgerEntryId: entry.id, refundedBeforeMinor: refunded.toString(), chargedMinor: chargedMinor.toString(),
      }) } })
      const after = await tx.bookingCreditNote.findFirstOrThrow({ where: { id, tenantId }, include: { booking: { select: { reference: true } } } })
      return this.view(after as Row, userId)
    })
  }

  async reject(tenantId: string, userId: string, creditNoteId: string, body: unknown): Promise<BookingCreditNoteView> {
    this.assertEnabled()
    const id = idParam('creditNoteId', creditNoteId)
    if (!id) throw refuse(400, 'creditNoteId is required', CREDIT_NOTE_FAILURE.invalid)
    const reason = parseDecisionReason(body)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const note = await tx.bookingCreditNote.findFirst({ where: { id, tenantId } })
      if (!note) throw refuse(404, 'Credit note not found', CREDIT_NOTE_FAILURE.notFound)
      if (note.status !== 'PROPOSED') throw refuse(409, 'This credit note is already decided', CREDIT_NOTE_FAILURE.decided)
      if (note.proposedById === userId) throw refuse(403, 'The person who proposed a credit note cannot reject it; withdraw it by asking another finance user', CREDIT_NOTE_FAILURE.ownProposal)
      const moved = await tx.bookingCreditNote.updateMany({ where: { id, tenantId, status: 'PROPOSED' }, data: { status: 'REJECTED', decidedById: userId, decidedAt: new Date(), decisionReason: reason } })
      if (moved.count !== 1) throw refuse(409, 'This credit note changed while you were deciding; reload it', CREDIT_NOTE_FAILURE.changed)
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.credit_note.rejected', entityType: 'booking_credit_note', entityId: id, payload: sanitizeAuditPayload({
        bookingId: note.bookingId, number: note.number, currency: note.currency, amountMinor: note.amountMinor.toString(), reason,
      }) } })
      const after = await tx.bookingCreditNote.findFirstOrThrow({ where: { id, tenantId }, include: { booking: { select: { reference: true } } } })
      return this.view(after as Row, userId)
    })
  }
}
