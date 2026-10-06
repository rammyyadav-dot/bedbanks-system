import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  BOOKING_DOCUMENT_PREFIX, BOOKING_DOCUMENT_TYPES, BOOKING_FINANCE_FAILURE, DOCUMENT_BLOCK_TEXT, PENALTY_REASON_MAX, classifyPenaltyChange, documentBlock, parseFrozenRules, parseMinor,
  type BookingAccessView, type BookingDocumentIssueResult, type BookingDocumentType, type BookingIssuedDocumentView, type BookingFinanceEventType, type BookingFinanceEventView, type BookingFinanceView,
  type BookingPenaltyRequest, type EffectivePenalty, type BookingPenaltyResult, type BookingStatus, type DocumentBlock, type StoredPenaltyQuote,
} from '@bedbanks/contracts'
import { renderBookingDocument } from '../agent/booking-document.render'
import { PrismaService } from '../database/prisma.service'
import { BookingActionsService } from './booking-actions.service'
import { BookingOpsDatabase } from './booking-ops-database'
import { BookingPenaltyQuoter } from './booking-penalty-quote'
import { currentPenalty } from './booking-finance-events'
import { buildDocumentPayload } from './booking-finance-documents'

const bad = (message: string, code: string) => new BadRequestException({ message, code })
const htmlPathOf = (bookingId: string, type: BookingDocumentType) => `/admin/operations/booking-finance/${bookingId}/documents/${type.toLowerCase().replace('_', '-')}/html`
const operatorWith = (access: BookingAccessView, key: string) => access.level === 'OPERATOR' && access.permissions.includes(key)
const refuse = (message: string, code: string = BOOKING_FINANCE_FAILURE.forbidden) => new ForbiddenException({ message, code })

/**
 * Money facts and documents of an Admin booking (ADR 0039, Phase 5). It reads and appends `BookingFinanceEvent` and issues `BookingDocument`s as the booking role.
 * It never posts to a ledger or a wallet and never calls a supplier. Every mutation is one transaction with its audit event; documents are immutable once issued.
 */
@Injectable()
export class BookingFinanceService {
  constructor(private readonly db: BookingOpsDatabase, private readonly prisma: PrismaService, private readonly quoter: BookingPenaltyQuoter) {}

  async view(tenantId: string, access: BookingAccessView, bookingId: string): Promise<BookingFinanceView> {
    if (!operatorWith(access, 'booking.finance.view')) throw refuse('You do not have permission to see booking finance')
    const now = new Date()
    const view = await this.db.withTenant(tenantId, async (tx) => {
      const b = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, reference: true, status: true, closedAt: true, currency: true, totalMinor: true, netMinor: true, paymentMode: true, isRefundable: true, hotelConfirmationNo: true, cancellationPolicy: true } })
      if (!b) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
      const state = await this.state(tx, tenantId, b)
      const canNet = access.permissions.includes('booking.view.net')
      const events = state.rows.map((e): BookingFinanceEventView => ({
        id: e.id, type: e.type as BookingFinanceEventType, seq: e.seq, currency: e.currency, sellMinor: e.sellMinor.toString(), netMinor: canNet && e.netMinor !== null ? e.netMinor.toString() : null,
        penaltyMinor: e.penaltyMinor === null ? null : e.penaltyMinor.toString(), refundMinor: e.refundMinor === null ? null : e.refundMinor.toString(), paymentMode: e.paymentMode, actorUserId: e.actorUserId, createdAt: e.createdAt.toISOString(),
        note: typeof (e.payload as { note?: unknown })?.note === 'string' ? (e.payload as { note: string }).note : null,
      }))
      const frozen = b.cancellationPolicy as { frozenAt?: string; source?: string } | null
      const rules = parseFrozenRules(b.cancellationPolicy)
      const eligible = Object.fromEntries(BOOKING_DOCUMENT_TYPES.map((t) => [t, this.block(t, b, state)])) as Record<BookingDocumentType, DocumentBlock>
      const waivedFrom = state.penalty.state === 'WAIVED' && state.quote?.status === 'quotable' ? state.quote.penaltyMinor : null
      return {
        bookingId: b.id, reference: b.reference, status: b.status as BookingStatus, closed: b.closedAt !== null, currency: b.currency, netMinor: canNet && b.netMinor !== null ? b.netMinor.toString() : null,
        sellMinor: b.totalMinor.toString(), paymentMode: b.paymentMode, isRefundable: b.isRefundable, terms: { rules, frozenAt: rules && frozen?.frozenAt ? frozen.frozenAt : null, source: rules && frozen?.source ? frozen.source : null },
        penalty: { ...state.penalty, quote: state.quote, waivedFrom }, events,
        documents: state.docs.map((d): BookingIssuedDocumentView => ({ id: d.id, type: d.type as BookingDocumentType, number: d.number, issuedAt: d.issuedAt.toISOString(), htmlPath: htmlPathOf(b.id, d.type as BookingDocumentType) })),
        eligible,
        can: { issueDocuments: operatorWith(access, 'booking.documents.issue'), decidePenalty: operatorWith(access, 'booking.cancel.nonrefundable'), waivePenalty: operatorWith(access, 'booking.penalty.waive.approve') },
        cancellationPreview: null,
        ledger: 'NOT_POSTED_BY_THIS_MODULE',
      } satisfies BookingFinanceView
    })
    // Worked out after the read transaction (it also reads the hotel's time zone with the API role). Only a Confirmed booking can be cancelled from here.
    return view.status === 'CONFIRMED' && !view.closed ? { ...view, cancellationPreview: await this.quoter.quote(tenantId, bookingId, now) } : view
  }

  /** Decide an undecided penalty (`booking.cancel.nonrefundable`) or waive part of a quoted one (`booking.penalty.waive.approve`, never by the person who requested the cancellation). */
  async changePenalty(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingPenaltyRequest, rawKey: unknown, requestId: string): Promise<BookingPenaltyResult> {
    const key = BookingActionsService.idempotencyKey(rawKey)
    if (access.level !== 'OPERATOR') throw refuse('You do not have permission to change a penalty')
    if (!body || typeof body !== 'object') throw bad('A request body is required', 'INVALID_REQUEST')
    const requested = parseMinor(body.penaltyMinor)
    if (requested === null) throw bad('penaltyMinor must be whole minor units (digits only)', 'PENALTY_INVALID')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) throw new BadRequestException({ message: 'Required: reason', code: 'MISSING_FIELDS', fields: ['reason'] })
    if (reason.length > PENALTY_REASON_MAX) throw bad('reason is too long', 'FIELD_TOO_LONG')
    const fingerprint = createHash('sha256').update(JSON.stringify([bookingId, requested.toString(), reason])).digest('hex')

    return this.db.withTenantWrite(tenantId, async (tx) => {
      const b = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, status: true, closedAt: true, currency: true, totalMinor: true, netMinor: true, paymentMode: true } })
      if (!b) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
      const replay = await tx.bookingFinanceEvent.findFirst({ where: { tenantId, bookingId, type: { in: ['PENALTY_DECIDED', 'PENALTY_WAIVED'] }, payload: { path: ['idempotencyKey'], equals: key } }, select: { type: true, penaltyMinor: true, refundMinor: true, payload: true } })
      if (replay) {
        if ((replay.payload as { fingerprint?: string }).fingerprint !== fingerprint) throw new ConflictException({ message: 'This idempotency key was already used for a different request', code: 'IDEMPOTENCY_CONFLICT' })
        return { bookingId, kind: replay.type === 'PENALTY_WAIVED' ? 'WAIVE' : 'DECIDE', penaltyMinor: String(replay.penaltyMinor), refundMinor: String(replay.refundMinor), replayed: true } satisfies BookingPenaltyResult
      }
      if (b.closedAt) throw new ConflictException({ message: 'This booking is closed and locked for edits', code: 'BOOKING_CLOSED' })
      if (b.status !== 'CANCEL_REQUESTED' && b.status !== 'CANCELLED') throw new ConflictException({ message: 'A penalty applies only to a booking whose cancellation was requested', code: 'PENALTY_NOT_OPEN' })
      const issued = await tx.bookingDocument.count({ where: { tenantId, bookingId, type: { in: ['CREDIT_NOTE', 'CANCELLATION_NOTE'] } } })
      if (issued > 0) throw new ConflictException({ message: 'Cancellation documents were already issued, so the penalty can no longer change', code: BOOKING_FINANCE_FAILURE.documentsIssued })

      const state = await currentPenalty(tx, { id: b.id, tenantId, currency: b.currency, totalMinor: b.totalMinor, netMinor: b.netMinor, paymentMode: b.paymentMode }, true)
      const change = classifyPenaltyChange(state.penalty, b.totalMinor, requested)
      if (change.kind === 'REFUSE') throw new ConflictException({ message: PENALTY_TEXT[change.code], code: change.code })
      if (change.kind === 'DECIDE') {
        if (!access.permissions.includes('booking.cancel.nonrefundable')) throw refuse('You do not have permission to decide a cancellation penalty')
      } else {
        if (!access.permissions.includes('booking.penalty.waive.approve')) throw refuse('You do not have permission to approve a penalty waiver')
        const requester = await tx.bookingEvent.findFirst({ where: { tenantId, bookingId, toStatus: 'CANCEL_REQUESTED', action: { in: ['requestCancellation', 'systemRequestCancellation'] } }, orderBy: { createdAt: 'desc' }, select: { actorId: true } })
        if (requester?.actorId === userId) throw refuse('The person who requested the cancellation cannot approve its waiver', BOOKING_FINANCE_FAILURE.selfWaive)
      }
      const type: BookingFinanceEventType = change.kind === 'WAIVE' ? 'PENALTY_WAIVED' : 'PENALTY_DECIDED'
      const seq = ((await tx.bookingFinanceEvent.aggregate({ where: { tenantId, bookingId, type }, _max: { seq: true } }))._max.seq ?? 0) + 1
      const refund = b.totalMinor - requested
      await tx.bookingFinanceEvent.create({ data: { tenantId, bookingId, type, seq, currency: b.currency, sellMinor: b.totalMinor, netMinor: b.netMinor, penaltyMinor: requested, refundMinor: refund, paymentMode: b.paymentMode, actorUserId: userId,
        payload: { idempotencyKey: key, fingerprint, note: reason, previousPenaltyMinor: state.penalty.state === 'NEEDS_DECISION' ? null : (state.penalty as { penaltyMinor: string }).penaltyMinor } } })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: change.kind === 'WAIVE' ? 'booking.penalty.waived' : 'booking.penalty.decided', entityType: 'booking', entityId: b.id,
        payload: { penaltyMinor: requested.toString(), refundMinor: refund.toString(), currency: b.currency, requestId, reasonGiven: true } }] })
      return { bookingId, kind: change.kind, penaltyMinor: requested.toString(), refundMinor: refund.toString(), replayed: false } satisfies BookingPenaltyResult
    })
  }

  /** Issue one document, once. Replays return the same document. The content is frozen at issue and cannot be edited (a database trigger enforces it). */
  async issueDocument(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, type: BookingDocumentType, requestId: string): Promise<BookingDocumentIssueResult> {
    if (!operatorWith(access, 'booking.documents.issue')) throw refuse('You do not have permission to issue booking documents')
    const content = await this.content(tenantId, bookingId)
    try {
      return await this.db.withTenantWrite(tenantId, async (tx) => {
        const b = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, reference: true, status: true, closedAt: true, currency: true, totalMinor: true, paymentMode: true, isRefundable: true, hotelConfirmationNo: true, agentRef: true, checkIn: true, checkOut: true, nights: true, cancellationPolicy: true, rooms: { orderBy: { position: 'asc' }, select: { roomName: true, boardCode: true, adults: true, children: true, childAges: true } }, guests: { orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }], select: { firstName: true, lastName: true, isLead: true } } } })
        if (!b) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
        const state = await this.state(tx, tenantId, b)
        const existing = state.docs.find((d) => d.type === type)
        if (existing) return { document: { id: existing.id, type, number: existing.number, issuedAt: existing.issuedAt.toISOString(), htmlPath: htmlPathOf(bookingId, type) }, replayed: true }
        const block = this.block(type, b, state)
        if (block) throw new ConflictException({ message: DOCUMENT_BLOCK_TEXT[block as Exclude<DocumentBlock, null>], code: block })
        const cancelled = state.rows.find((e) => e.type === 'CANCELLED')
        const payload = buildDocumentPayload(type, { booking: b, content, penalty: state.penalty, quote: state.quote, cancelledAt: cancelled?.createdAt ?? null })
        const number = `${BOOKING_DOCUMENT_PREFIX[type]}-${b.reference}`
        const created = await tx.bookingDocument.create({ data: { tenantId, bookingId, type, number, payload: payload as Prisma.InputJsonObject }, select: { id: true, issuedAt: true } })
        await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.document.issued', entityType: 'booking', entityId: b.id, payload: { documentId: created.id, type, number, requestId } }] })
        return { document: { id: created.id, type, number, issuedAt: created.issuedAt.toISOString(), htmlPath: htmlPathOf(bookingId, type) }, replayed: false }
      })
    } catch (error) {
      // Two operators issued at once: the unique (booking, type) key let one through; the other reads the winner.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      const won = await this.db.withTenant(tenantId, (tx) => tx.bookingDocument.findFirst({ where: { tenantId, bookingId, type }, select: { id: true, number: true, issuedAt: true } }))
      if (!won) throw error
      return { document: { id: won.id, type, number: won.number, issuedAt: won.issuedAt.toISOString(), htmlPath: htmlPathOf(bookingId, type) }, replayed: true }
    }
  }

  async documentHtml(tenantId: string, access: BookingAccessView, bookingId: string, type: BookingDocumentType): Promise<string> {
    if (!operatorWith(access, 'booking.documents.issue')) throw refuse('You do not have permission to view booking documents')
    const doc = await this.db.withTenant(tenantId, (tx) => tx.bookingDocument.findFirst({ where: { tenantId, bookingId, type }, select: { type: true, number: true, issuedAt: true, payload: true, booking: { select: { status: true } } } }))
    if (!doc) throw new NotFoundException({ message: 'This document has not been issued', code: 'DOCUMENT_NOT_ISSUED' })
    return renderBookingDocument({ type: doc.type, number: doc.number, issuedAt: doc.issuedAt.toISOString(), bookingStatus: doc.booking.status, payload: doc.payload as Record<string, any> })
  }

  // ---- internals --------------------------------------------------------------------------------------------------------
  private async state(tx: Prisma.TransactionClient, tenantId: string, b: { id: string; status: string; currency: string; totalMinor: bigint; netMinor?: bigint | null; paymentMode: string | null; hotelConfirmationNo: string | null }) {
    const requested = b.status === 'CANCEL_REQUESTED' || b.status === 'CANCELLED'
    const [rows, docs] = await Promise.all([
      tx.bookingFinanceEvent.findMany({ where: { tenantId, bookingId: b.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      tx.bookingDocument.findMany({ where: { tenantId, bookingId: b.id }, orderBy: { issuedAt: 'asc' }, select: { id: true, type: true, number: true, issuedAt: true } }),
    ])
    const { quote, penalty } = await currentPenalty(tx, { id: b.id, tenantId, currency: b.currency, totalMinor: b.totalMinor, netMinor: b.netMinor ?? null, paymentMode: b.paymentMode }, requested)
    return { rows, docs, quote: quote as StoredPenaltyQuote | null, penalty }
  }

  private block(type: BookingDocumentType, b: { status: string; totalMinor: bigint; hotelConfirmationNo: string | null }, s: { rows: Array<{ type: string }>; docs: Array<{ type: string }>; penalty: EffectivePenalty }): DocumentBlock {
    return documentBlock(type, { status: b.status as BookingStatus, hasConfirmedEvent: s.rows.some((e) => e.type === 'CONFIRMED'), hotelConfirmationNo: b.hotelConfirmationNo, penalty: s.penalty, sellMinor: b.totalMinor.toString(), issued: s.docs.map((d) => d.type as BookingDocumentType) })
  }

  /** The hotel, tenant and board names the booking role cannot read; fetched with the API role before the write transaction. */
  private content(tenantId: string, bookingId: string) {
    return this.db.withTenant(tenantId, (tx) => tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { hotelId: true } })).then(async (b) => {
      if (!b) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
      return this.prisma.withTenant(tenantId, async (t) => {
        const [tenant, hotel] = await Promise.all([t.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }), t.hotel.findFirst({ where: { id: b.hotelId, tenantId }, select: { name: true, city: true, countryCode: true } })])
        return { issuedFor: tenant?.name ?? '', hotel: hotel ? { name: hotel.name, city: hotel.city, countryCode: hotel.countryCode.trim() } : null }
      })
    })
  }
}

const PENALTY_TEXT = {
  PENALTY_UNCHANGED: 'That is already the penalty.',
  PENALTY_CANNOT_INCREASE: 'The penalty is fixed when cancellation is requested. It can be waived down, never raised.',
  PENALTY_INVALID: 'The penalty must be between zero and the booking total.',
  PENALTY_NOT_OPEN: 'A penalty applies only to a booking whose cancellation was requested.',
} as const
