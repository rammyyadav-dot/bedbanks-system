import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type {
  AuditEventView, BookingAttention, BookingOperations, BookingRow, CancellationRow, ConnectorExecutionView, ConnectorRow,
  HoldDetail, HoldNightView, HoldRow, InventoryHoldStatus, LedgerEntryView, Paged, ReconciliationCase, ReconciliationQueue,
  OperationsReadiness, ReconcileRequest, ReconcileResponse, WalletRow,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { BookingReconciliationService } from '../agent/booking-reconciliation.service'
import { documentKindFromRoute } from '../agent/booking-document.service'
import { renderBookingDocument } from '../agent/booking-document.render'
import { bookingAttention, DEFAULT_PREBOOK_MAX_MINUTES, DEFAULT_STALE_MINUTES } from './booking-attention'
import { day, guardedRead, iso, sectionRead } from './operations-read'
import { boolParam, dayParam, endOfDay, enumParam, idParam, intParam, pageParams, paged, textParam } from './query-params'

const HOLD_STATUSES = ['PENDING_RECHECK', 'RECHECKED', 'HOLD_PENDING', 'HELD', 'PROCESSING', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'FAILED'] as const
const BOOKING_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'] as const
const LEDGER_TYPES = ['CREDIT', 'DEBIT', 'HOLD', 'RELEASE', 'REFUND'] as const
const SCAN_LIMIT = 500

type Snapshot = { checkIn?: string; checkOut?: string; rooms?: number; adults?: number; children?: number; inventoryHoldId?: string; ratePlanId?: string; offerId?: string; searchId?: string; roomTypeId?: string; canonicalRoomTypeId?: string; boardBasisId?: string; snapshotVersion?: number; canonicalHotelId?: string }
const snap = (value: Prisma.JsonValue): Snapshot => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Snapshot) : {})
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
const int = (value: unknown): number | null => (Number.isInteger(value) ? (value as number) : null)

/** Audit payloads are sanitised on write; request/correlation ids live in the payload. */
function auditView(row: { id: string; createdAt: Date; action: string; entityType: string; entityId: string; actorType: string; userId: string | null; payload: Prisma.JsonValue }): AuditEventView {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {}
  return { id: row.id, at: row.createdAt.toISOString(), action: row.action, entityType: row.entityType, entityId: row.entityId, actorType: row.actorType, userId: row.userId, requestId: str(payload.requestId), correlationId: str(payload.correlationId), payload }
}

/** Read-only, tenant-scoped transaction views for Admin. Tenant always comes from the authenticated server context. */
@Injectable()
export class OperationsTransactionsService {
  constructor(private readonly prisma: PrismaService, private readonly reconciliation: BookingReconciliationService) {}

  // ---- holds -------------------------------------------------------------------------------------------------------
  async holds(tenantId: string, query: Record<string, unknown>): Promise<Paged<HoldRow>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, HOLD_STATUSES)
    const hotelId = idParam('hotelId', query.hotelId)
    const from = dayParam('from', query.from)
    const to = dayParam('to', query.to)
    const where: Prisma.InventoryHoldWhereInput = { tenantId, ...(status && { status }), ...(hotelId && { canonicalHotelId: hotelId }), ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: endOfDay(to) }) } }) }
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([
        tx.inventoryHold.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.inventoryHold.count({ where }),
      ])
      return paged(await this.holdRows(tx, tenantId, rows), page, total)
    }))
  }

  async hold(tenantId: string, holdIdRaw: string): Promise<HoldDetail> {
    const holdId = idParam('holdId', holdIdRaw)
    if (!holdId) throw new BadRequestException('Invalid holdId')
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const hold = await tx.inventoryHold.findFirst({ where: { id: holdId, tenantId }, include: { nights: { orderBy: { stayDate: 'asc' } } } })
      if (!hold) throw new NotFoundException('Hold not found')
      const [row] = await this.holdRows(tx, tenantId, [hold])
      const availability = await this.availabilityFor(tx, tenantId, hold.nights.map(n => n.availabilityId))
      const audit = await tx.auditEvent.findMany({ where: { tenantId, entityType: 'inventory_hold', entityId: hold.id }, orderBy: { createdAt: 'asc' }, take: 100 })
      return { ...row, offerId: hold.offerId, searchId: hold.searchId, ratePlanId: hold.ratePlanId, boardBasisId: hold.boardBasisId, nights: hold.nights.map(n => this.nightView(n, availability.get(n.availabilityId))), audit: audit.map(auditView) }
    }))
  }

  private async availabilityFor(tx: Prisma.TransactionClient, tenantId: string, ids: string[]) {
    const rows = ids.length ? await tx.dailyAvailability.findMany({ where: { tenantId, id: { in: ids } } }) : []
    return new Map(rows.map(r => [r.id, r]))
  }

  private nightView(night: { stayDate: Date; quantity: number; availabilityId: string }, a: { allotment: number; sold: number; held: number; stopSell: boolean } | undefined): HoldNightView {
    return { stayDate: day(night.stayDate), quantity: night.quantity, allotment: a?.allotment ?? null, sold: a?.sold ?? null, held: a?.held ?? null, remaining: a ? a.allotment - a.sold - a.held : null, stopSell: a?.stopSell ?? null }
  }

  private async holdRows(tx: Prisma.TransactionClient, tenantId: string, holds: Array<Prisma.InventoryHoldGetPayload<object>>): Promise<HoldRow[]> {
    const hotelIds = [...new Set(holds.map(h => h.canonicalHotelId))]
    const roomIds = [...new Set(holds.map(h => h.canonicalRoomTypeId))]
    const [hotels, rooms, bookings] = await Promise.all([
      hotelIds.length ? tx.hotel.findMany({ where: { tenantId, id: { in: hotelIds } }, select: { id: true, name: true } }) : [],
      roomIds.length ? tx.roomType.findMany({ where: { hotel: { tenantId }, id: { in: roomIds } }, select: { id: true, name: true } }) : [],
      holds.length ? tx.booking.findMany({ where: { tenantId, OR: holds.map(h => ({ searchSnapshot: { path: ['inventoryHoldId'], equals: h.id } })) }, select: { id: true, reference: true, status: true, searchSnapshot: true } }) : [],
    ])
    const hotelName = new Map(hotels.map(h => [h.id, h.name]))
    const roomName = new Map(rooms.map(r => [r.id, r.name]))
    const byHold = new Map(bookings.map(b => [snap(b.searchSnapshot).inventoryHoldId, b]))
    return holds.map(h => {
      const b = byHold.get(h.id)
      return {
        id: h.id, tenantId: h.tenantId, status: h.status as InventoryHoldStatus, hotelId: h.canonicalHotelId, hotelName: hotelName.get(h.canonicalHotelId) ?? null, roomTypeId: h.canonicalRoomTypeId, roomName: roomName.get(h.canonicalRoomTypeId) ?? null,
        checkIn: day(h.checkIn), checkOut: day(h.checkOut), rooms: h.rooms, currency: h.currency, sellAmountMinor: h.sellAmountMinor.toString(), createdAt: h.createdAt.toISOString(), expiresAt: h.expiresAt.toISOString(), releasedAt: iso(h.releasedAt), requestId: h.requestId,
        booking: b ? { id: b.id, reference: b.reference, status: b.status } : null,
      }
    })
  }

  // ---- bookings ----------------------------------------------------------------------------------------------------
  async bookings(tenantId: string, query: Record<string, unknown>): Promise<Paged<BookingRow>> {
    const page = pageParams(query)
    const status = enumParam('status', query.status, BOOKING_STATUSES)
    const reference = textParam('reference', query.reference, 64)
    const hotelId = idParam('hotelId', query.hotelId)
    const supplier = textParam('supplier', query.supplier, 64)
    const createdFrom = dayParam('createdFrom', query.createdFrom)
    const createdTo = dayParam('createdTo', query.createdTo)
    const checkInFrom = dayParam('checkInFrom', query.checkInFrom)
    const checkInTo = dayParam('checkInTo', query.checkInTo)
    const attentionOnly = boolParam('attention', query.attention) === true
    const base: Prisma.BookingWhereInput = {
      tenantId, ...(status && { status }), ...(hotelId && { hotelId }), ...(supplier && { supplier }),
      // Exact or prefix match only; never a contains/wildcard scan.
      ...(reference && { reference: { startsWith: reference } }),
      ...((createdFrom || createdTo) && { createdAt: { ...(createdFrom && { gte: createdFrom }), ...(createdTo && { lte: endOfDay(createdTo) }) } }),
    }
    const inWindow = (b: { searchSnapshot: Prisma.JsonValue }) => {
      if (!checkInFrom && !checkInTo) return true
      const ci = str(snap(b.searchSnapshot).checkIn)
      if (!ci) return false
      return (!checkInFrom || ci >= day(checkInFrom)) && (!checkInTo || ci <= day(checkInTo))
    }
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const needsScan = attentionOnly || Boolean(checkInFrom || checkInTo)
      if (!needsScan) {
        const [rows, total] = await Promise.all([
          tx.booking.findMany({ where: base, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
          tx.booking.count({ where: base }),
        ])
        return paged(await this.bookingRows(tx, tenantId, rows), page, total)
      }
      // Snapshot-derived filters are evaluated over a bounded newest-first window; the cap is part of the response contract.
      const scanned = await tx.booking.findMany({ where: base, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: SCAN_LIMIT })
      const rows = (await this.bookingRows(tx, tenantId, scanned.filter(inWindow))).filter(r => !attentionOnly || r.attention.length > 0)
      return paged(rows.slice(page.skip, page.skip + page.take), page, rows.length)
    }))
  }

  private async evidence(tx: Prisma.TransactionClient, tenantId: string, bookings: Array<{ id: string; searchSnapshot: Prisma.JsonValue }>) {
    const holdIds = bookings.map(b => snap(b.searchSnapshot).inventoryHoldId).filter((v): v is string => typeof v === 'string')
    const ids = bookings.map(b => b.id)
    const [holds, ledger, cancellations, prebooks] = await Promise.all([
      holdIds.length ? tx.inventoryHold.findMany({ where: { tenantId, id: { in: holdIds } }, select: { id: true, status: true, updatedAt: true } }) : [],
      ids.length ? tx.ledgerEntry.findMany({ where: { tenantId, OR: [{ reference: { in: ids.map(i => `booking:${i}`) } }, ...ids.map(i => ({ idempotencyKey: { startsWith: `booking:${i}:` } }))] }, select: { type: true, amountMinor: true, reference: true, idempotencyKey: true } }) : [],
      ids.length ? tx.cancellation.findMany({ where: { bookingId: { in: ids }, booking: { tenantId } }, select: { bookingId: true, refundMinor: true, reason: true, createdAt: true } }) : [],
      ids.length ? tx.auditEvent.findMany({ where: { tenantId, action: 'booking.prebook.succeeded', entityId: { in: ids } }, select: { entityId: true, createdAt: true }, orderBy: { createdAt: 'desc' } }) : [],
    ])
    return { holds: new Map(holds.map(h => [h.id, h])), ledger, cancellations: new Map(cancellations.map(c => [c.bookingId, c])), prebooks: new Map(prebooks.map(p => [p.entityId, p.createdAt])) }
  }

  private attentionFor(booking: { id: string; status: string; searchSnapshot: Prisma.JsonValue }, ev: Awaited<ReturnType<OperationsTransactionsService['evidence']>>, now: Date): BookingAttention[] {
    const hold = ev.holds.get(snap(booking.searchSnapshot).inventoryHoldId ?? '')
    const entries = ev.ledger.filter(e => e.reference === `booking:${booking.id}` || e.idempotencyKey.startsWith(`booking:${booking.id}:`))
    const refund = entries.filter(e => e.type === 'REFUND').reduce((sum, e) => sum + e.amountMinor, 0n)
    const cancellation = ev.cancellations.get(booking.id)
    return bookingAttention({
      bookingStatus: booking.status, holdStatus: hold?.status ?? null, holdUpdatedAt: hold?.updatedAt ?? null, prebookAt: ev.prebooks.get(booking.id) ?? null,
      hasDebit: entries.some(e => e.type === 'DEBIT'), refundPostedMinor: refund, cancellation: cancellation ? { refundMinor: cancellation.refundMinor } : null, now,
      staleMinutes: DEFAULT_STALE_MINUTES, prebookMaxMinutes: DEFAULT_PREBOOK_MAX_MINUTES,
    })
  }

  private async bookingRows(tx: Prisma.TransactionClient, tenantId: string, bookings: Array<Prisma.BookingGetPayload<object>>): Promise<BookingRow[]> {
    const ev = await this.evidence(tx, tenantId, bookings)
    const hotelIds = [...new Set(bookings.map(b => b.hotelId))]
    const hotels = hotelIds.length ? await tx.hotel.findMany({ where: { tenantId, id: { in: hotelIds } }, select: { id: true, name: true } }) : []
    const roomIds = [...new Set(bookings.map(b => str(snap(b.searchSnapshot).roomTypeId ?? snap(b.searchSnapshot).canonicalRoomTypeId)).filter((v): v is string => v !== null))]
    const rooms = roomIds.length ? await tx.roomType.findMany({ where: { hotel: { tenantId }, id: { in: roomIds } }, select: { id: true, name: true } }) : []
    const hn = new Map(hotels.map(h => [h.id, h.name]))
    const rn = new Map(rooms.map(r => [r.id, r.name]))
    const now = new Date()
    return bookings.map(b => {
      const s = snap(b.searchSnapshot)
      return {
        id: b.id, reference: b.reference, status: b.status, tenantId: b.tenantId, supplier: b.supplier, hotelId: b.hotelId, hotelName: hn.get(b.hotelId) ?? null,
        roomName: rn.get(str(s.roomTypeId ?? s.canonicalRoomTypeId) ?? '') ?? null, checkIn: str(s.checkIn), checkOut: str(s.checkOut), currency: b.currency, totalMinor: b.totalMinor.toString(),
        createdAt: b.createdAt.toISOString(), holdId: str(s.inventoryHoldId), attention: this.attentionFor(b, ev, now),
      }
    })
  }

  async booking(tenantId: string, bookingIdRaw: string): Promise<BookingOperations> {
    const bookingId = idParam('bookingId', bookingIdRaw)
    if (!bookingId) throw new BadRequestException('Invalid bookingId')
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, include: { documents: { select: { type: true, number: true, issuedAt: true }, orderBy: { issuedAt: 'asc' } } } })
      if (!booking) throw new NotFoundException('Booking not found')
      const s = snap(booking.searchSnapshot)
      const holdId = str(s.inventoryHoldId)
      const roomTypeId = str(s.roomTypeId ?? s.canonicalRoomTypeId)
      const boardBasisId = str(s.boardBasisId)
      const [hotel, room, board, hold, ev] = await Promise.all([
        tx.hotel.findFirst({ where: { tenantId, id: booking.hotelId }, select: { name: true } }),
        roomTypeId ? tx.roomType.findFirst({ where: { hotel: { tenantId }, id: roomTypeId }, select: { name: true } }) : null,
        boardBasisId ? tx.boardBasis.findFirst({ where: { tenantId, id: boardBasisId }, select: { code: true } }) : null,
        holdId ? tx.inventoryHold.findFirst({ where: { tenantId, id: holdId }, include: { nights: { orderBy: { stayDate: 'asc' } } } }) : null,
        this.evidence(tx, tenantId, [booking]),
      ])
      const availability = hold ? await this.availabilityFor(tx, tenantId, hold.nights.map(n => n.availabilityId)) : new Map()
      const entries = await tx.ledgerEntry.findMany({ where: { tenantId, OR: [{ reference: `booking:${booking.id}` }, { idempotencyKey: { startsWith: `booking:${booking.id}:` } }] }, orderBy: [{ immutableAt: 'asc' }, { id: 'asc' }] })
      const audit = await tx.auditEvent.findMany({ where: { tenantId, OR: [{ entityType: 'booking', entityId: booking.id }, ...(holdId ? [{ entityType: 'inventory_hold', entityId: holdId }] : [])] }, orderBy: { createdAt: 'asc' }, take: 200 })
      const cancellation = ev.cancellations.get(booking.id) ?? null
      const refundPosted = entries.filter(e => e.type === 'REFUND').reduce((sum, e) => sum + e.amountMinor, 0n)
      const views = audit.map(auditView)
      const confirmation = views.find(a => a.action === 'booking.confirmed' || a.action === 'booking.confirm.succeeded') ?? null
      const prebook = views.find(a => a.action === 'booking.prebook.succeeded') ?? null
      const issuable: Array<'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE'> = booking.status === 'CONFIRMED' ? ['VOUCHER', 'INVOICE'] : booking.status === 'CANCELLED' ? ['INVOICE', 'CREDIT_NOTE'] : []
      return {
        booking: { id: booking.id, reference: booking.reference, status: booking.status, createdAt: booking.createdAt.toISOString(), updatedAt: booking.updatedAt.toISOString(), tenantId: booking.tenantId, createdByRequestId: null },
        stay: { hotelId: booking.hotelId, hotelName: hotel?.name ?? null, roomTypeId, roomName: room?.name ?? null, boardBasisId, boardCode: board?.code ?? null, checkIn: str(s.checkIn), checkOut: str(s.checkOut), rooms: int(s.rooms), adults: int(s.adults), children: int(s.children) },
        commercial: { currency: booking.currency, totalMinor: booking.totalMinor.toString(), offerId: str(s.offerId), searchId: str(s.searchId), ratePlanId: str(s.ratePlanId), snapshotVersion: int(s.snapshotVersion) },
        inventory: { holdId, hold: hold ? { status: hold.status as InventoryHoldStatus, expiresAt: hold.expiresAt.toISOString(), releasedAt: iso(hold.releasedAt), rooms: hold.rooms, nights: hold.nights.map(n => this.nightView(n, availability.get(n.availabilityId))) } : null },
        supplier: { supplier: booking.supplier, supplierBookingReference: null, prebook: prebook ? { at: prebook.at, requestId: prebook.requestId } : null, confirmation: confirmation ? { at: confirmation.at, requestId: confirmation.requestId } : null },
        finance: { entries: entries.map(e => this.ledgerView(e, booking.id)), netMinor: entries.reduce((sum, e) => sum + e.amountMinor, 0n).toString() },
        documents: booking.documents.map(d => ({ type: d.type as 'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE', number: d.number, issuedAt: d.issuedAt.toISOString() })),
        issuableDocuments: issuable,
        cancellation: { record: cancellation ? { reason: cancellation.reason, refundMinor: cancellation.refundMinor === null ? null : cancellation.refundMinor.toString(), createdAt: cancellation.createdAt.toISOString() } : null, refundPosted: refundPosted.toString() },
        attention: this.attentionFor(booking, ev, new Date()),
        audit: views,
      }
    }))
  }

  /**
   * Renders an already-issued document. Unlike the agent route this never issues one: Admin is read-only,
   * and documents are immutable once issued.
   */
  async documentHtml(tenantId: string, bookingIdRaw: string, typeRaw: string): Promise<string> {
    const bookingId = idParam('bookingId', bookingIdRaw)
    if (!bookingId) throw new BadRequestException('Invalid bookingId')
    const type = documentKindFromRoute(typeRaw)
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { status: true } })
      if (!booking) throw new NotFoundException('Booking not found')
      const document = await tx.bookingDocument.findFirst({ where: { tenantId, bookingId, type } })
      if (!document) throw new NotFoundException('This document has not been issued')
      return renderBookingDocument({ type, number: document.number, issuedAt: document.issuedAt.toISOString(), bookingStatus: booking.status, payload: document.payload as Record<string, any> })
    }))
  }

  // ---- reconciliation ----------------------------------------------------------------------------------------------
  async reconciliationQueue(tenantId: string, userId: string, requestId: string): Promise<ReconciliationQueue> {
    return guardedRead(async () => {
      const now = new Date()
      const dry = await this.reconciliation.reconcileStale({ tenantId, userId, requestId, dryRun: true, now })
      const cases: ReconciliationCase[] = []
      const holdIds = dry.items.map(i => i.holdId)
      const bookingIds = dry.items.map(i => i.bookingId).filter((v): v is string => v !== null)
      const { holds, bookings } = await this.prisma.withTenant(tenantId, async tx => ({
        holds: holdIds.length ? await tx.inventoryHold.findMany({ where: { tenantId, id: { in: holdIds } }, select: { id: true, status: true, updatedAt: true } }) : [],
        bookings: bookingIds.length ? await tx.booking.findMany({ where: { tenantId, id: { in: bookingIds } }, select: { id: true, reference: true, status: true } }) : [],
      }))
      const hm = new Map(holds.map(h => [h.id, h])); const bm = new Map(bookings.map(b => [b.id, b]))
      for (const item of dry.items) {
        const h = hm.get(item.holdId); const b = item.bookingId ? bm.get(item.bookingId) : undefined
        cases.push({ source: 'reconciliation_dry_run', kind: item.outcome, bookingId: item.bookingId, bookingReference: b?.reference ?? null, bookingStatus: b?.status ?? null, holdId: item.holdId, holdStatus: h?.status ?? null, detail: `Hold stuck in PROCESSING; a reconcile run would record "${item.outcome}".`, observedAt: (h?.updatedAt ?? now).toISOString() })
      }
      // Consistency evidence: bookings whose attention flags are raised but which the stale-hold sweep does not cover.
      const covered = new Set(bookingIds)
      const recent = await this.prisma.withTenant(tenantId, async tx => this.bookingRows(tx, tenantId, await tx.booking.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: SCAN_LIMIT })))
      for (const row of recent) {
        for (const flag of row.attention) {
          if (covered.has(row.id) && flag === 'RECONCILIATION_REQUIRED') continue
          cases.push({ source: 'consistency_check', kind: flag, bookingId: row.id, bookingReference: row.reference, bookingStatus: row.status, holdId: row.holdId, holdStatus: null, detail: `Booking ${row.reference} is flagged ${flag}. Investigate; no state has been changed.`, observedAt: now.toISOString() })
        }
      }
      return { generatedAt: now.toISOString(), staleMinutes: dry.staleMinutes, total: cases.length, cases }
    })
  }

  /** Runs the existing, idempotent reconcile. Reconcile-or-nothing: this never overrides a status. */
  async reconcile(tenantId: string, userId: string, requestId: string, body: ReconcileRequest): Promise<ReconcileResponse> {
    const staleMinutes = intParam('staleMinutes', body?.staleMinutes, 1, 10_080)
    const prebookMaxMinutes = intParam('prebookMaxMinutes', body?.prebookMaxMinutes, 15, 10_080)
    const result = await guardedRead(() => this.reconciliation.reconcileStale({ tenantId, userId, requestId, staleMinutes, prebookMaxMinutes, dryRun: false }))
    return { dryRun: false, examined: result.examined, items: result.items.map(i => ({ holdId: i.holdId, bookingId: i.bookingId, outcome: i.outcome })) }
  }

  // ---- cancellations -----------------------------------------------------------------------------------------------
  async cancellations(tenantId: string, query: Record<string, unknown>): Promise<Paged<CancellationRow>> {
    const page = pageParams(query)
    const where: Prisma.CancellationWhereInput = { booking: { tenantId } }
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([
        tx.cancellation.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take, include: { booking: true } }),
        tx.cancellation.count({ where }),
      ])
      const bookings = rows.map(r => r.booking)
      const ev = await this.evidence(tx, tenantId, bookings)
      const hotels = await tx.hotel.findMany({ where: { tenantId, id: { in: [...new Set(bookings.map(b => b.hotelId))] } }, select: { id: true, name: true } })
      const hn = new Map(hotels.map(h => [h.id, h.name]))
      return paged(rows.map(r => {
        const refundPosted = ev.ledger.filter(e => e.type === 'REFUND' && (e.reference === `booking:${r.bookingId}` || e.idempotencyKey.startsWith(`booking:${r.bookingId}:`))).reduce((sum, e) => sum + e.amountMinor, 0n)
        return {
          bookingId: r.bookingId, reference: r.booking.reference, bookingStatus: r.booking.status, hotelName: hn.get(r.booking.hotelId) ?? null, checkIn: str(snap(r.booking.searchSnapshot).checkIn),
          currency: r.booking.currency, totalMinor: r.booking.totalMinor.toString(), reason: r.reason, refundMinor: r.refundMinor === null ? null : r.refundMinor.toString(), refundPosted: refundPosted.toString(),
          refundMatches: (r.refundMinor ?? 0n) === refundPosted, createdAt: r.createdAt.toISOString(),
        }
      }), page, total)
    }))
  }

  // ---- finance -----------------------------------------------------------------------------------------------------
  async wallets(tenantId: string, query: Record<string, unknown>): Promise<Paged<WalletRow>> {
    const page = pageParams(query)
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [wallets, total] = await Promise.all([
        tx.wallet.findMany({ where: { tenantId }, orderBy: [{ currency: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take }),
        tx.wallet.count({ where: { tenantId } }),
      ])
      const sums = wallets.length ? await tx.ledgerEntry.groupBy({ by: ['walletId'], where: { tenantId, walletId: { in: wallets.map(w => w.id) } }, _sum: { amountMinor: true }, _count: { _all: true } }) : []
      const sm = new Map(sums.map(s => [s.walletId, s]))
      return paged(wallets.map(w => {
        const sum = sm.get(w.id)?._sum.amountMinor ?? 0n
        // Same formula as the finance service: available credit = credit limit + SUM(all ledger entries).
        return { id: w.id, tenantId: w.tenantId, currency: w.currency, creditLimit: w.creditLimit.toString(), balanceMinor: sum.toString(), availableCreditMinor: (w.creditLimit + sum).toString(), cachedBalanceMinor: w.cachedBalance.toString(), cacheMatchesLedger: w.cachedBalance === sum, entryCount: sm.get(w.id)?._count._all ?? 0, updatedAt: w.updatedAt.toISOString() }
      }), page, total)
    }))
  }

  private ledgerView(e: { id: string; walletId: string; type: string; amountMinor: bigint; currency: string; reference: string | null; idempotencyKey: string; immutableAt: Date }, bookingId: string | null): LedgerEntryView {
    return { id: e.id, walletId: e.walletId, type: e.type, amountMinor: e.amountMinor.toString(), currency: e.currency, reference: e.reference, idempotencyKey: e.idempotencyKey, at: e.immutableAt.toISOString(), bookingId }
  }

  async ledger(tenantId: string, query: Record<string, unknown>): Promise<Paged<LedgerEntryView>> {
    const page = pageParams(query)
    const walletId = idParam('walletId', query.walletId)
    const type = enumParam('type', query.type, LEDGER_TYPES)
    const bookingId = idParam('bookingId', query.bookingId)
    const from = dayParam('from', query.from)
    const to = dayParam('to', query.to)
    const where: Prisma.LedgerEntryWhereInput = {
      tenantId, ...(walletId && { walletId }), ...(type && { type }),
      ...(bookingId && { OR: [{ reference: `booking:${bookingId}` }, { idempotencyKey: { startsWith: `booking:${bookingId}:` } }] }),
      ...((from || to) && { immutableAt: { ...(from && { gte: from }), ...(to && { lte: endOfDay(to) }) } }),
    }
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([
        tx.ledgerEntry.findMany({ where, orderBy: [{ immutableAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.ledgerEntry.count({ where }),
      ])
      return paged(rows.map(e => this.ledgerView(e, e.reference?.startsWith('booking:') ? e.reference.slice('booking:'.length) : null)), page, total)
    }))
  }

  // ---- audit -------------------------------------------------------------------------------------------------------
  async audit(tenantId: string, query: Record<string, unknown>): Promise<Paged<AuditEventView>> {
    const page = pageParams(query)
    const requestId = idParam('requestId', query.requestId)
    const correlationId = idParam('correlationId', query.correlationId)
    const action = textParam('action', query.action, 80)
    const entityType = textParam('entityType', query.entityType, 64)
    const entityId = idParam('entityId', query.entityId)
    const userId = idParam('userId', query.userId)
    const from = dayParam('from', query.from)
    const to = dayParam('to', query.to)
    const where: Prisma.AuditEventWhereInput = {
      tenantId, ...(action && { action: { startsWith: action } }), ...(entityType && { entityType }), ...(entityId && { entityId }), ...(userId && { userId }),
      ...(requestId && { payload: { path: ['requestId'], equals: requestId } }),
      ...(correlationId && { AND: [{ payload: { path: ['correlationId'], equals: correlationId } }] }),
      ...((from || to) && { createdAt: { ...(from && { gte: from }), ...(to && { lte: endOfDay(to) }) } }),
    }
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([
        tx.auditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.auditEvent.count({ where }),
      ])
      return paged(rows.map(auditView), page, total)
    }))
  }

  // ---- connectors --------------------------------------------------------------------------------------------------
  async connectors(tenantId: string, query: Record<string, unknown>): Promise<Paged<ConnectorRow>> {
    const page = pageParams(query)
    return guardedRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([
        tx.connectorDefinition.findMany({ where: { tenantId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take, include: { supplier: { select: { id: true, displayName: true } }, credentialReferences: { select: { purpose: true, secretRef: true } } } }),
        tx.connectorDefinition.count({ where: { tenantId } }),
      ])
      const out: ConnectorRow[] = []
      for (const c of rows) {
        const [last, ok, bad] = await Promise.all([
          tx.connectorExecution.findFirst({ where: { tenantId, connectorId: c.id }, orderBy: { createdAt: 'desc' } }),
          tx.connectorExecution.findFirst({ where: { tenantId, connectorId: c.id, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' } }),
          tx.connectorExecution.findFirst({ where: { tenantId, connectorId: c.id, status: 'FAILED' }, orderBy: { createdAt: 'desc' } }),
        ])
        const view = (e: typeof last): ConnectorExecutionView | null => (e ? { operation: e.operation, status: e.status, latencyMs: e.latencyMs, errorClassification: e.errorClassification, at: e.createdAt.toISOString() } : null)
        out.push({
          id: c.id, name: c.name, type: c.type, status: c.status, healthState: c.healthState, version: c.version, supplier: c.supplier, capabilityCount: Array.isArray(c.capabilities) ? c.capabilities.length : 0,
          // Presence only: the secret reference itself is never returned.
          credentials: c.credentialReferences.map(r => ({ purpose: r.purpose, status: r.secretRef ? 'configured' as const : 'missing' as const })),
          lastExecution: view(last), lastSuccess: view(ok), lastFailure: view(bad),
        })
      }
      return paged(out, page, total)
    }))
  }

  // ---- dashboard sections (explicit "unavailable" when the runtime role cannot read them) --------------------------------
  transactionSummary(tenantId: string): Promise<OperationsReadiness['transactions']> {
    return sectionRead(() => this.prisma.withTenant(tenantId, async tx => {
      const [holds, bookings, recent] = await Promise.all([
        tx.inventoryHold.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
        tx.booking.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
        tx.booking.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: SCAN_LIMIT }),
      ])
      const hc = (s: string) => holds.find(h => h.status === s)?._count._all ?? 0
      const bc = (s: string) => bookings.find(b => b.status === s)?._count._all ?? 0
      const rows = await this.bookingRows(tx, tenantId, recent)
      return {
        holds: { held: hc('HELD'), processing: hc('PROCESSING'), total: holds.reduce((n, h) => n + h._count._all, 0) },
        bookings: { pending: bc('PENDING'), confirmed: bc('CONFIRMED'), failed: bc('FAILED'), cancelled: bc('CANCELLED'), total: bookings.reduce((n, b) => n + b._count._all, 0) },
        reconciliationRequired: rows.filter(r => r.attention.includes('RECONCILIATION_REQUIRED') || r.attention.includes('PREBOOK_EXPIRED_UNRESOLVED')).length,
        cancellationsMissingRefund: rows.filter(r => r.attention.includes('REFUND_MISSING') || r.attention.includes('CANCELLATION_RECORD_MISSING')).length,
      }
    }))
  }

  connectorSummary(tenantId: string): Promise<OperationsReadiness['connectors']> {
    return sectionRead(() => this.prisma.withTenant(tenantId, async tx => {
      const rows = await tx.connectorDefinition.findMany({ where: { tenantId }, select: { status: true, healthState: true } })
      return { total: rows.length, enabled: rows.filter(r => r.status === 'ACTIVE').length, unhealthy: rows.filter(r => r.healthState !== 'unknown' && r.healthState !== 'healthy').length, unknown: rows.filter(r => r.healthState === 'unknown').length }
    }))
  }
}
