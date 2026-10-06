import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes, createHash } from 'node:crypto'
import {
  BOOKING_ACTION_RULES, BOOKING_ACTIONS, BOOKING_REASON_MAX, BOOKING_REF_MAX, BOOKING_STATUSES, MANUAL_BOOKING_FAILURE, permissionFor,
  type BookingAccessView, type BookingAction, type BookingActionRequest, type BookingReferencesRequest, type BookingStatus, type BookingWriteResult, type ManualBookingRequest,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { manualBookingEnabled } from './booking-access.guard'
import { BookingOpsDatabase } from './booking-ops-database'
import { transitionBooking } from './booking-transition'
import { validateManualBooking } from './manual-booking'

const KEY = /^[A-Za-z0-9._:-]{8,128}$/
const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const bad = (message: string, code: string) => new BadRequestException({ message, code })

/** Everything an Admin user can change on a booking (ADR 0039, Phase 2). Each public method is one transaction on the booking role and one audit event. */
@Injectable()
export class BookingActionsService {
  constructor(private readonly db: BookingOpsDatabase, private readonly prisma: PrismaService) {}

  static idempotencyKey(raw: unknown): string {
    if (typeof raw !== 'string' || !KEY.test(raw)) throw bad('An Idempotency-Key header of 8 to 128 letters, digits or . _ : - is required', 'IDEMPOTENCY_KEY_REQUIRED')
    return raw
  }

  /** Run one named lifecycle action. */
  async act(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingActionRequest, rawKey: unknown, requestId: string, now = new Date()): Promise<BookingWriteResult> {
    const key = BookingActionsService.idempotencyKey(rawKey)
    if (!body || typeof body !== 'object') throw bad('A request body is required', 'INVALID_REQUEST')
    if (!(BOOKING_ACTIONS as readonly string[]).includes(body.action)) throw bad('Unknown booking action', 'UNKNOWN_ACTION')
    if (!(BOOKING_STATUSES as readonly string[]).includes(body.expectedStatus)) throw bad('expectedStatus is required', 'INVALID_REQUEST')
    for (const field of ['reason', 'supplierRef', 'hotelConfirmationNo', 'supplierCancellationRef'] as const) if (body[field] !== undefined && typeof body[field] !== 'string') throw bad(`${field} must be text`, 'INVALID_REQUEST')
    const action: BookingAction = body.action
    const rule = BOOKING_ACTION_RULES[action]
    const level = access.level
    const held = new Set(access.permissions)

    return this.db.withTenantWrite(tenantId, async (tx) => {
      const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, agencyId: true, isRefundable: true } })
      // An agency-scoped caller never learns another agency's booking exists.
      if (!booking || (level === 'AGENCY' && booking.agencyId !== access.agencyId)) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
      const permission = permissionFor(rule, level, held, booking.isRefundable)
      if (!permission) {
        await this.prisma.withTenant(tenantId, (t) => t.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'permission.denied', entityType: 'booking', entityId: booking.id, payload: { bookingAction: action, requestId } } })).catch(() => undefined)
        throw new ForbiddenException({ message: 'You do not have permission for this action on this booking', code: 'PERMISSION_DENIED' })
      }
      const outcome = await transitionBooking(tx, {
        tenantId, bookingId: booking.id, action, expectedStatus: body.expectedStatus as BookingStatus, actor: { type: 'USER', id: userId }, level, now,
        reason: clean(body.reason), supplierRef: clean(body.supplierRef), hotelConfirmationNo: clean(body.hotelConfirmationNo), supplierCancellationRef: clean(body.supplierCancellationRef),
        confirmNonRefundable: body.confirmNonRefundable === true, idempotencyKey: key,
      })
      if (!outcome.replayed) {
        // Same transaction as the status change: either both exist or neither. Free-text (reason) is never copied into the audit payload.
        await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: `booking.${action}`, entityType: 'booking', entityId: booking.id, payload: { bookingAction: action, from: rule.from, to: rule.to, permission, level, requestId, reasonGiven: Boolean(clean(body.reason)) } }] })
      }
      return outcome
    })
  }

  /** Add or correct the supplier / hotel / agent references. The status is untouched. */
  async editReferences(tenantId: string, userId: string, access: BookingAccessView, bookingId: string, body: BookingReferencesRequest, rawKey: unknown, requestId: string): Promise<BookingWriteResult> {
    const key = BookingActionsService.idempotencyKey(rawKey)
    if (access.level !== 'OPERATOR' || !access.permissions.includes('booking.supplier-ref.edit')) throw new ForbiddenException({ message: 'You do not have permission to edit references', code: 'PERMISSION_DENIED' })
    if (!body || typeof body !== 'object') throw bad('A request body is required', 'INVALID_REQUEST')
    const reason = clean(body.reason)
    if (!reason) throw new BadRequestException({ message: 'Required: reason', code: 'MISSING_FIELDS', fields: ['reason'] })
    if (reason.length > BOOKING_REASON_MAX) throw bad('reason is too long', 'FIELD_TOO_LONG')
    const fields = ['supplierRef', 'hotelConfirmationNo', 'agentRef'] as const
    const next: Partial<Record<(typeof fields)[number], string | null>> = {}
    for (const f of fields) {
      const v = body[f]
      if (v === undefined) continue
      if (v !== null && typeof v !== 'string') throw bad(`${f} must be text or null`, 'INVALID_REQUEST')
      const t = v === null ? null : v.trim() || null
      if (t && t.length > BOOKING_REF_MAX) throw bad(`${f} is too long`, 'FIELD_TOO_LONG')
      next[f] = t
    }
    if (Object.keys(next).length === 0) throw bad('Nothing to change', 'INVALID_REQUEST')
    const fingerprint = createHash('sha256').update(JSON.stringify([bookingId, 'editReferences', next, reason])).digest('hex')

    return this.db.withTenantWrite(tenantId, async (tx) => {
      const earlier = await tx.bookingEvent.findUnique({ where: { tenantId_bookingId_idempotencyKey: { tenantId, bookingId, idempotencyKey: key } }, select: { requestFingerprint: true } })
      const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { id: true, reference: true, status: true, version: true, closedAt: true, supplierRef: true, hotelConfirmationNo: true, agentRef: true } })
      if (!booking) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })
      if (earlier) {
        if (earlier.requestFingerprint !== fingerprint) throw new ConflictException({ message: 'This idempotency key was already used for a different request', code: 'IDEMPOTENCY_CONFLICT' })
        return { bookingId: booking.id, reference: booking.reference, status: booking.status as BookingStatus, version: booking.version, closed: booking.closedAt !== null, replayed: true }
      }
      if (booking.closedAt) throw new ConflictException({ message: 'This booking is closed and locked for edits', code: 'BOOKING_CLOSED' })
      const changed = (Object.keys(next) as Array<(typeof fields)[number]>).filter((f) => (next[f] ?? null) !== (booking[f] ?? null))
      if (changed.length === 0) throw bad('Nothing to change', 'NO_CHANGE')
      const done = await tx.booking.updateMany({ where: { id: booking.id, tenantId, closedAt: null }, data: Object.fromEntries(changed.map((f) => [f, next[f] ?? null])) })
      if (done.count !== 1) throw new ConflictException({ message: 'The booking changed while you were working. Reload and try again.', code: 'STALE_STATUS' })
      const diff = Object.fromEntries(changed.map((f) => [f, { from: booking[f] ?? null, to: next[f] ?? null }]))
      await tx.bookingEvent.create({ data: { tenantId, bookingId: booking.id, fromStatus: booking.status, toStatus: booking.status, actorType: 'USER', actorId: userId, reason, action: 'editReferences', payload: { changed: diff }, idempotencyKey: key, requestFingerprint: fingerprint } })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.references.edited', entityType: 'booking', entityId: booking.id, payload: { fields: changed, requestId } }] })
      return { bookingId: booking.id, reference: booking.reference, status: booking.status as BookingStatus, version: booking.version, closed: false, replayed: false }
    })
  }

  /** Enter a booking by hand (phone or offline). No supplier is called, no inventory is held, no credit is used. */
  async createManual(tenantId: string, userId: string, access: BookingAccessView, body: ManualBookingRequest, rawKey: unknown, requestId: string): Promise<BookingWriteResult> {
    const key = BookingActionsService.idempotencyKey(rawKey)
    if (!manualBookingEnabled()) throw new ForbiddenException({ message: 'Manual booking entry is switched off in this environment', code: MANUAL_BOOKING_FAILURE.disabled })
    if (access.level !== 'OPERATOR' || !access.permissions.includes('booking.manual.create')) throw new ForbiddenException({ message: 'You do not have permission to enter a booking manually', code: 'PERMISSION_DENIED' })
    const valid = validateManualBooking(body ?? {})
    const fingerprint = createHash('sha256').update(JSON.stringify([valid, (valid.sellMinor).toString()], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).digest('hex')

    // The API database role (not the booking role) confirms the hotel and the agency belong to this operator and that the agency is active.
    const [hotel, agency] = await this.prisma.withTenant(tenantId, (t) => Promise.all([t.hotel.findFirst({ where: { id: valid.hotelId, tenantId }, select: { id: true } }), t.agency.findFirst({ where: { id: valid.agencyId, tenantId }, select: { id: true, status: true } })]))
    if (!hotel) throw bad('Hotel not found for this operator', 'HOTEL_NOT_FOUND')
    if (!agency) throw bad('Agency not found for this operator', 'AGENCY_NOT_FOUND')
    if (agency.status !== 'ACTIVE') throw new ConflictException({ message: 'New bookings are blocked for an agency that is not active', code: 'AGENCY_NOT_ACTIVE' })

    return this.db.withTenantWrite(tenantId, async (tx) => {
      const existing = await tx.booking.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } }, select: { id: true, reference: true, status: true, version: true, closedAt: true, searchSnapshot: true } })
      if (existing) {
        const stored = (existing.searchSnapshot as { manual?: { requestFingerprint?: string } } | null)?.manual?.requestFingerprint
        if (stored !== fingerprint) throw new ConflictException({ message: 'This idempotency key was already used for a different request', code: 'IDEMPOTENCY_CONFLICT' })
        return { bookingId: existing.id, reference: existing.reference, status: existing.status as BookingStatus, version: existing.version, closed: existing.closedAt !== null, replayed: true }
      }
      const reference = `FB-${randomBytes(10).toString('hex').toUpperCase()}`
      const snapshot = { source: 'manual', manual: { requestFingerprint: fingerprint, enteredBy: userId }, checkIn: valid.checkIn, checkOut: valid.checkOut, nights: valid.nights, currency: valid.currency, sellMinor: valid.sellMinor.toString() }
      const created = await tx.booking.create({ data: {
        tenantId, reference, supplier: valid.supplier, hotelId: valid.hotelId, status: 'PENDING_SUPPLIER', currency: valid.currency, totalMinor: valid.sellMinor, idempotencyKey: key, searchSnapshot: snapshot,
        agencyId: valid.agencyId, channel: 'MANUAL', agentRef: valid.agentRef, checkIn: new Date(`${valid.checkIn}T00:00:00Z`), checkOut: new Date(`${valid.checkOut}T00:00:00Z`), nights: valid.nights,
        netMinor: valid.netMinor, markupMinor: valid.markupMinor, paymentMode: valid.paymentMode, isRefundable: valid.isRefundable, cancelDeadline: valid.cancelDeadline,
      }, select: { id: true, version: true } })
      const rooms = []
      for (const room of valid.rooms) rooms.push(await tx.bookingRoom.create({ data: { tenantId, bookingId: created.id, position: room.position, roomName: room.roomName, boardCode: room.boardCode, adults: room.adults, children: room.children, childAges: room.childAges }, select: { id: true } }))
      for (const guest of valid.guests) await tx.bookingGuest.create({ data: { tenantId, bookingId: created.id, roomId: rooms[0]?.id ?? null, title: guest.title, firstName: guest.firstName, lastName: guest.lastName, isLead: guest.isLead, type: guest.type, age: guest.age }, select: { id: true } })
      await tx.bookingEvent.create({ data: { tenantId, bookingId: created.id, fromStatus: null, toStatus: 'PENDING_SUPPLIER', actorType: 'USER', actorId: userId, reason: null, action: 'createManual', payload: { channel: 'MANUAL', noSupplierCall: true, noCreditUsed: true } } })
      await tx.auditEvent.createMany({ data: [{ tenantId, userId, actorType: 'USER', action: 'booking.manual.created', entityType: 'booking', entityId: created.id, payload: { channel: 'MANUAL', agencyId: valid.agencyId, hotelId: valid.hotelId, currency: valid.currency, sellMinor: valid.sellMinor.toString(), rooms: valid.rooms.length, guests: valid.guests.length, requestId } }] })
      return { bookingId: created.id, reference, status: 'PENDING_SUPPLIER' as const, version: created.version, closed: false, replayed: false }
    })
  }
}
