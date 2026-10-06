import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  availableActions,
  OPERATIONS_READ_DENIED,
  type BookingAccessView, type BookingAttention, type BookingDetailView, type BookingGuestView, type BookingListPage, type BookingListRow, type BookingOperations, type BookingRoomView, type BookingStatus, type BookingTimelineItem, type SectionState,
} from '@bedbanks/contracts'
import { BookingOpsDatabase } from '../booking-ops/booking-ops-database'
import { buildBookingOrderBy, buildBookingWhere, describeApplied, parseBookingListQuery, type BookingFilter } from '../booking-ops/booking-list-query'
import { guestName } from '../booking-ops/booking-masking'
import { PrismaService } from '../database/prisma.service'
import { sectionRead } from './operations-read'
import { auditView, OperationsTransactionsService } from './operations-transactions.service'

/** The newest bookings the reconciliation-flag filter will examine; the response says when the cap was reached. */
export const BOOKING_ATTENTION_SCAN_CAP = 500
const HOTEL_TEXT_CAP = 200
const REFERENCE_PARAM = /^[A-Za-z0-9_.:-]{1,80}$/

type CoreRow = Prisma.BookingGetPayload<{ include: { rooms: true; guests: true } }>
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)
const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null)

/**
 * The Admin booking list and detail (ADR 0039, Phase 1). Read-only.
 *
 * Booking rows, rooms, guests and the lifecycle log are read through the booking module's own limited database principal (`BookingOpsDatabase`):
 * the API role is denied those tables by design. Names (hotels, agencies, users) and the existing transaction evidence are read with the API role and
 * degrade explicitly: a name that cannot be read is null, and unreadable reconciliation evidence is `attention: null`, never "no flags".
 * Scope is applied here from the authenticated access (tenant, and agency for agency-scoped callers), never from a query parameter.
 */
@Injectable()
export class OperationsBookingsService {
  /** Replaceable in tests so every date rule is deterministic. */
  clock: () => Date = () => new Date()

  constructor(private readonly ops: BookingOpsDatabase, private readonly prisma: PrismaService, private readonly evidence: OperationsTransactionsService) {}

  // ---- list ---------------------------------------------------------------------------------------------------------------
  async list(tenantId: string, userId: string, access: BookingAccessView, rawQuery: Record<string, unknown>, requestId: string): Promise<BookingListPage> {
    const filter = parseBookingListQuery(rawQuery, access)
    const now = this.clock()
    const hotelIds = filter.hotelText ? await this.resolveHotels(tenantId, filter.hotelText) : null
    const where = buildBookingWhere(filter, { tenantId, access }, hotelIds, now)
    const orderBy = buildBookingOrderBy(filter)
    const include = { rooms: { orderBy: { position: 'asc' as const }, take: 1 }, guests: { where: { isLead: true }, orderBy: { createdAt: 'asc' as const }, take: 1 } }

    let rows: CoreRow[]; let total: number; let scanCapped = false
    let attention: Map<string, BookingAttention[]> | null = null
    if (filter.attention) {
      // Reconciliation flags need the existing transaction evidence; evaluate them over the newest bookings and say when the cap was reached.
      const scanned = await this.ops.withTenant(tenantId, (tx) => tx.booking.findMany({ where, orderBy, take: BOOKING_ATTENTION_SCAN_CAP, include }))
      attention = await this.evidence.attentionByBooking(tenantId, scanned)
      if (attention === null) throw new ServiceUnavailableException({ message: 'Reconciliation flags are not readable by the API database role, so this filter cannot be applied. Grants must be reviewed by a human; see ADR 0039.', code: OPERATIONS_READ_DENIED })
      const flagged = scanned.filter((b) => (attention!.get(b.id) ?? []).length > 0)
      total = flagged.length; scanCapped = scanned.length === BOOKING_ATTENTION_SCAN_CAP
      rows = flagged.slice((filter.page - 1) * filter.pageSize, filter.page * filter.pageSize)
    } else {
      const [page, count] = await this.ops.withTenant(tenantId, (tx) => Promise.all([
        tx.booking.findMany({ where, orderBy, skip: (filter.page - 1) * filter.pageSize, take: filter.pageSize, include }),
        tx.booking.count({ where }),
      ]))
      rows = page; total = count
      attention = await this.evidence.attentionByBooking(tenantId, rows)
    }

    const names = await this.names(tenantId, rows)
    const items = rows.map((b) => this.row(b, names, access, attention?.get(b.id) ?? null, attention !== null))
    await this.auditUnmasked(tenantId, userId, access, rows, requestId, 'booking.pii.list_viewed', 'booking_list', requestId)
    return {
      items, page: filter.page, pageSize: filter.pageSize, total, access, applied: describeApplied(filter), attentionAvailable: attention !== null, scanCapped,
    }
  }

  /** Hotels matching a name, city or country text, within this tenant. A text that matches no hotel matches no booking. */
  private async resolveHotels(tenantId: string, text: string): Promise<string[]> {
    const contains = { contains: text.replace(/[\\%_]/g, (c) => `\\${c}`), mode: 'insensitive' as const }
    const hotels = await this.prisma.withTenant(tenantId, (tx) => tx.hotel.findMany({ where: { tenantId, OR: [{ name: contains }, { city: contains }, { countryCode: { equals: text, mode: 'insensitive' } }] }, select: { id: true }, take: HOTEL_TEXT_CAP + 1 }))
    if (hotels.length > HOTEL_TEXT_CAP) throw new BadRequestException('That hotel search matches too many hotels; narrow it')
    return hotels.map((h) => h.id)
  }

  private async names(tenantId: string, rows: Array<{ hotelId: string; agencyId: string | null; agentUserId: string | null; assignedToId: string | null }>) {
    const hotelIds = [...new Set(rows.map((r) => r.hotelId))]
    const agencyIds = [...new Set(rows.map((r) => r.agencyId).filter((v): v is string => v !== null))]
    const userIds = [...new Set(rows.flatMap((r) => [r.agentUserId, r.assignedToId]).filter((v): v is string => v !== null))]
    const read = await sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const [hotels, agencies, users] = await Promise.all([
        hotelIds.length ? tx.hotel.findMany({ where: { tenantId, id: { in: hotelIds } }, select: { id: true, name: true, city: true, timeZone: true, address: true } }) : [],
        agencyIds.length ? tx.agency.findMany({ where: { tenantId, id: { in: agencyIds } }, select: { id: true, name: true } }) : [],
        userIds.length ? tx.user.findMany({ where: { id: { in: userIds }, memberships: { some: { tenantId } } }, select: { id: true, name: true, email: true } }) : [],
      ])
      return { hotels: new Map(hotels.map((h) => [h.id, h])), agencies: new Map(agencies.map((a) => [a.id, a.name])), users: new Map(users.map((u) => [u.id, u.name || u.email])) }
    }))
    return read.state === 'available' ? read.data : { hotels: new Map<string, { id: string; name: string; city: string; timeZone: string; address: string | null }>(), agencies: new Map<string, string>(), users: new Map<string, string>() }
  }

  private row(b: CoreRow, names: Awaited<ReturnType<OperationsBookingsService['names']>>, access: BookingAccessView, attention: BookingAttention[] | null, attentionKnown: boolean): BookingListRow {
    const hotel = names.hotels.get(b.hotelId)
    const room = b.rooms[0]
    const lead = b.guests[0]
    const netKnown = access.canViewNet && b.netMinor !== null
    return {
      id: b.id, reference: b.reference, status: b.status, supplierStatus: b.supplierStatus,
      agency: b.agencyId ? { id: b.agencyId, name: names.agencies.get(b.agencyId) ?? b.agencyId } : null,
      agent: b.agentUserId ? names.users.get(b.agentUserId) ?? null : null,
      supplier: b.supplier, supplierRef: b.supplierRef, hotelConfirmationNo: b.hotelConfirmationNo, agentRef: b.agentRef, channel: b.channel,
      leadGuest: lead ? guestName(lead.firstName, lead.lastName, access.canViewPii) : null,
      guests: room ? { adults: room.adults * room.quantity, children: room.children * room.quantity } : null,
      hotel: { id: b.hotelId, name: hotel?.name ?? null, city: hotel?.city ?? null, timeZone: hotel?.timeZone ?? null },
      room: room ? { name: room.roomName, board: room.boardCode, quantity: room.quantity } : null,
      checkIn: day(b.checkIn), checkOut: day(b.checkOut), nights: b.nights, createdAt: b.createdAt.toISOString(), cancelDeadline: iso(b.cancelDeadline),
      currency: b.currency, sellMinor: b.totalMinor.toString(),
      netMinor: netKnown ? b.netMinor!.toString() : null,
      marginMinor: netKnown ? (b.totalMinor - b.netMinor!).toString() : null,
      paymentMode: b.paymentMode, paymentStatus: b.paymentStatus, isRefundable: b.isRefundable, version: b.version, closedAt: iso(b.closedAt),
      assignedTo: b.assignedToId ? { id: b.assignedToId, name: names.users.get(b.assignedToId) ?? b.assignedToId } : null,
      missingSupplierRef: b.status === 'CONFIRMED' && b.supplierRef === null, amended: b.version > 1,
      attention: attentionKnown ? attention ?? [] : null,
    }
  }

  // ---- detail -------------------------------------------------------------------------------------------------------------
  /** `idOrReference` is the booking id or its `FB-` reference. Another agency's booking, and another tenant's, are 404 for an agency-scoped caller. */
  async detail(tenantId: string, userId: string, access: BookingAccessView, idOrReference: string, requestId: string): Promise<BookingDetailView> {
    if (!REFERENCE_PARAM.test(idOrReference)) throw new BadRequestException('Invalid booking')
    const key = idOrReference.toUpperCase().startsWith('FB-') ? { reference: idOrReference.toUpperCase() } : { id: idOrReference }
    const scope: Prisma.BookingWhereInput = { tenantId, ...key, ...(access.level === 'AGENCY' ? { agencyId: access.agencyId ?? '__none__' } : {}) }
    const core = await this.ops.withTenant(tenantId, async (tx) => {
      const b = await tx.booking.findFirst({ where: scope, include: { rooms: { orderBy: { position: 'asc' } }, guests: { orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }] } } })
      if (!b) throw new NotFoundException('Booking not found')
      const events = await tx.bookingEvent.findMany({ where: { tenantId, bookingId: b.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 })
      return { b, events }
    })
    const { b, events } = core
    const names = await this.names(tenantId, [b])
    const hotel = names.hotels.get(b.hotelId)
    const row = this.row(b, names, access, null, false)
    const roomPosition = new Map(b.rooms.map((r) => [r.id, r.position]))
    const rooms: BookingRoomView[] = b.rooms.map((r) => ({
      position: r.position, quantity: r.quantity, roomName: r.roomName, boardCode: r.boardCode, adults: r.adults, children: r.children, childAges: r.childAges,
      sellMinor: r.sellMinor === null ? null : r.sellMinor.toString(), netMinor: access.canViewNet && r.netMinor !== null ? r.netMinor.toString() : null,
    }))
    const guests: BookingGuestView[] = b.guests.map((g) => ({ ...guestName(g.firstName, g.lastName, access.canViewPii), isLead: g.isLead, type: g.type, age: g.age, roomPosition: g.roomId ? roomPosition.get(g.roomId) ?? null : null }))
    const netVisibility = !access.canViewNet ? 'HIDDEN_BY_PERMISSION' as const : b.netMinor === null ? 'NOT_RECORDED' as const : 'VISIBLE' as const

    // Internal evidence and audit are for operator-level callers only.
    const operationsRecord = access.level === 'OPERATOR' ? await this.operationsRecord(tenantId, b.id) : null
    const timeline = await this.timeline(tenantId, b.id, events, access, names.users)
    if (access.canViewPii && b.guests.length > 0) await this.auditUnmasked(tenantId, userId, access, [b], requestId, 'booking.pii.viewed', 'booking', b.id)

    const { attention: _a, leadGuest: _l, guests: _g, room: _r, ...rest } = row
    return {
      access,
      booking: { ...rest, hotelAddress: hotel?.address ?? null, specialRequests: null },
      rooms, guests,
      pricing: {
        currency: b.currency, sellMinor: b.totalMinor.toString(),
        netMinor: row.netMinor, markupMinor: access.canViewNet && b.markupMinor !== null ? b.markupMinor.toString() : null, marginMinor: row.marginMinor,
        fxRate: b.fxRate === null ? null : b.fxRate.toString(), isRefundable: b.isRefundable, cancelDeadline: iso(b.cancelDeadline),
        cancellationPolicy: null, markupRule: null, netVisibility,
      },
      timeline, operationsRecord,
      availableActions: availableActions({ status: b.status as BookingStatus, closedAt: iso(b.closedAt), isRefundable: b.isRefundable, checkIn: b.checkIn ? b.checkIn.toISOString().slice(0, 10) : null }, access.level, new Set(access.permissions), new Date()),
    }
  }

  private async operationsRecord(tenantId: string, bookingId: string): Promise<SectionState<BookingOperations>> {
    try {
      return { state: 'available', data: await this.evidence.booking(tenantId, bookingId) }
    } catch (error) {
      // The existing record needs tables the API role may not read. That is a labelled gap, not an error and not an empty record.
      if (error instanceof ServiceUnavailableException || error instanceof NotFoundException) return { state: 'unavailable', reason: OPERATIONS_READ_DENIED }
      throw error
    }
  }

  private async timeline(tenantId: string, bookingId: string, events: Array<Prisma.BookingEventGetPayload<object>>, access: BookingAccessView, users: Map<string, string>): Promise<BookingTimelineItem[]> {
    const status: BookingTimelineItem[] = events.map((e) => {
      const backfilled = (e.payload as { backfill?: unknown } | null)?.backfill === true
      return {
        kind: 'status', at: e.createdAt.toISOString(), title: e.fromStatus ? `${e.fromStatus} → ${e.toStatus}` : `Recorded as ${e.toStatus}`, fromStatus: e.fromStatus as BookingStatus | null, toStatus: e.toStatus as BookingStatus,
        actorType: e.actorType, actor: e.actorId ? users.get(e.actorId) ?? null : null, reason: access.level === 'OPERATOR' ? e.reason : null, // internal reasons (supplier answers, failure notes) are for operators
        action: (e.action as BookingTimelineItem['action']) ?? null, backfilled, requestId: null,
      }
    })
    if (access.level !== 'OPERATOR') return status
    const audit = await sectionRead(() => this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { tenantId, entityType: 'booking', entityId: bookingId, action: { startsWith: 'booking.' } }, orderBy: { createdAt: 'asc' }, take: 200 })))
    const items: BookingTimelineItem[] = audit.state === 'available'
      ? audit.data.map((a) => { const v = auditView(a); return { kind: 'audit' as const, at: v.at, title: v.action, fromStatus: null, toStatus: null, actorType: (a.actorType === 'USER' ? 'USER' : 'SYSTEM') as 'USER' | 'SYSTEM', actor: v.userId ? users.get(v.userId) ?? null : null, reason: null, action: null, backfilled: false, requestId: v.requestId } })
      : []
    return [...status, ...items].sort((x, y) => x.at.localeCompare(y.at))
  }

  /** Every unmasked read of guest names is audited. The payload never carries a name. */
  private async auditUnmasked(tenantId: string, userId: string, access: BookingAccessView, rows: Array<{ id: string; guests?: unknown[] }>, requestId: string, action: string, entityType: string, entityId: string): Promise<void> {
    if (!access.canViewPii) return
    const revealed = rows.filter((r) => (r.guests?.length ?? 0) > 0)
    if (revealed.length === 0) return
    await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action, entityType, entityId, payload: { requestId, bookingCount: revealed.length, bookingIds: revealed.slice(0, 100).map((r) => r.id) } } }))
  }
}

export type { BookingFilter }
