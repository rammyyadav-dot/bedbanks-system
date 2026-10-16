import { readFrozenTerms } from './booking-cancellation-terms'
import { rulesForPlan } from '../supply/cancellation-rules'
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from './audit.service'
import { readSpecialRequests, specialRequestLabels } from './special-requests'

export type DocumentKind = 'VOUCHER' | 'INVOICE' | 'CREDIT_NOTE'
export const DOCUMENT_ROUTE_TYPES: Record<string, DocumentKind> = { voucher: 'VOUCHER', invoice: 'INVOICE', 'credit-note': 'CREDIT_NOTE' }
const PREFIX: Record<DocumentKind, string> = { VOUCHER: 'VCH', INVOICE: 'INV', CREDIT_NOTE: 'CN' }

export interface IssuedDocument { id: string; type: DocumentKind; number: string; issuedAt: string; bookingStatus: string; payload: Record<string, any>; alreadyIssued: boolean }

export function documentKindFromRoute(value: string): DocumentKind {
  // own-property check: '__proto__', 'constructor' etc. must not resolve through the prototype chain
  const kind = Object.prototype.hasOwnProperty.call(DOCUMENT_ROUTE_TYPES, value) ? DOCUMENT_ROUTE_TYPES[value] : undefined
  if (!kind) throw new BadRequestException('Unknown document type')
  return kind
}

/**
 * Issues each booking document exactly once and freezes its content. Numbers are derived from the booking reference
 * (no shared counter to race on); a database unique key plus an UPDATE-rejecting trigger make re-issue and edits
 * impossible. Eligibility: voucher needs a CONFIRMED booking, invoice a charged booking (CONFIRMED or CANCELLED),
 * credit note a CANCELLED booking.
 */
@Injectable()
export class BookingDocumentService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  async get(input: { tenantId: string; userId: string; requestId: string; bookingId: string; type: DocumentKind }): Promise<IssuedDocument> {
    const { tenantId, userId, requestId, bookingId, type } = input
    let issuedNow = false
    const result = await this.issue(tenantId, bookingId, type).then(value => { issuedNow = !value.alreadyIssued; return value }, async error => {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      return this.issue(tenantId, bookingId, type) // lost an issue race: read the winner
    })
    if (issuedNow) {
      await this.audit.record({ tenantId, userId, action: 'booking.document.issued', entityType: 'booking', entityId: bookingId, payload: { requestId, documentId: result.id, type, number: result.number } })
        .catch(() => undefined)
    }
    return result
  }

  private issue(tenantId: string, bookingId: string, type: DocumentKind): Promise<IssuedDocument> {
    return this.prisma.withTenant(tenantId, async tx => {
      const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId } })
      if (!booking) throw new NotFoundException('Booking not found')
      const existing = await tx.bookingDocument.findUnique({ where: { bookingId_type: { bookingId, type } } })
      if (existing) return this.view(existing, booking.status, true)

      if (type === 'VOUCHER' && booking.status !== 'CONFIRMED') throw new ConflictException('A voucher is issued only for a confirmed booking')
      if (type === 'INVOICE' && booking.status !== 'CONFIRMED' && booking.status !== 'CANCELLED') throw new ConflictException('An invoice is issued only for a charged booking')
      if (type === 'CREDIT_NOTE' && booking.status !== 'CANCELLED') throw new ConflictException('A credit note is issued only for a cancelled booking')

      const payload = await this.build(tx, tenantId, booking, type)
      const created = await tx.bookingDocument.create({ data: { tenantId, bookingId, type, number: `${PREFIX[type]}-${booking.reference}`, payload: payload as Prisma.InputJsonObject } })
      return this.view(created, booking.status, false)
    })
  }

  private view(doc: { id: string; type: string; number: string; issuedAt: Date; payload: Prisma.JsonValue }, bookingStatus: string, alreadyIssued: boolean): IssuedDocument {
    return { id: doc.id, type: doc.type as DocumentKind, number: doc.number, issuedAt: doc.issuedAt.toISOString(), bookingStatus, payload: doc.payload as Record<string, any>, alreadyIssued }
  }

  private async build(tx: Prisma.TransactionClient, tenantId: string, booking: { id: string; reference: string; currency: string; totalMinor: bigint; searchSnapshot: Prisma.JsonValue; cancellationPolicy: Prisma.JsonValue | null; agentRef: string | null; specialRequests: Prisma.JsonValue | null; agencyId: string | null; hotelConfirmationNo: string | null }, type: DocumentKind) {
    const s = booking.searchSnapshot as Record<string, any>
    const [tenant, hotel, room, board, plan, guests, agency] = await Promise.all([
      tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
      tx.hotel.findFirst({ where: { id: s.canonicalHotelId, tenantId } }),
      tx.roomType.findFirst({ where: { id: s.canonicalRoomTypeId, hotel: { tenantId } } }),
      tx.boardBasis.findFirst({ where: { id: s.boardBasisId, tenantId } }),
      tx.ratePlan.findFirst({ where: { id: s.ratePlanId, tenantId }, include: { contract: { include: { cancellationPolicies: { orderBy: { daysBeforeCheckin: 'desc' } } } } } }),
      tx.bookingGuest.findMany({ where: { bookingId: booking.id, tenantId }, orderBy: [{ roomNumber: 'asc' }, { isLead: 'desc' }, { type: 'asc' }, { createdAt: 'asc' }], select: { roomNumber: true, title: true, firstName: true, lastName: true, type: true, age: true, isLead: true } }),
      booking.agencyId ? tx.agency.findFirst({ where: { id: booking.agencyId, tenantId }, select: { name: true } }) : Promise.resolve(null),
    ])
    const profile = hotel ? await tx.hotelProfile.findFirst({ where: { hotelId: hotel.id, tenantId }, select: { checkInTime: true, checkOutTime: true } }) : null
    if (!hotel || !room || !board) throw new ConflictException('Booking content is incomplete')
    const nights = Math.round((Date.parse(`${s.checkOut}T00:00:00.000Z`) - Date.parse(`${s.checkIn}T00:00:00.000Z`)) / 86_400_000)
    const base = {
      bookingReference: booking.reference, issuedFor: tenant.name,
      hotel: { name: hotel.name, city: hotel.city, countryCode: hotel.countryCode },
      room: { name: room.name }, board: { code: board.code.trim(), name: board.name },
      stay: { checkIn: s.checkIn, checkOut: s.checkOut, nights, rooms: s.rooms, adults: s.adults, children: s.children, childAges: s.childAges ?? [] },
      leadGuest: s.leadGuest,
      // ADR 0066: agency file reference, every guest by room, hotel address and times. No hotel contact detail (HotelProfile.contacts stays private).
      ...(booking.agentRef ? { agentRef: booking.agentRef } : {}),
      ...(booking.hotelConfirmationNo ? { hotelConfirmationNo: booking.hotelConfirmationNo } : {}),
      ...(agency ? { agencyName: agency.name } : {}),
      hotelDetails: { address: hotel.address ?? null, checkInTime: profile?.checkInTime?.trim() || null, checkOutTime: profile?.checkOutTime?.trim() || null },
      guestsByRoom: guestRooms(guests),
    }
    if (type === 'VOUCHER') {
      const requests = readSpecialRequests(booking.specialRequests)
      const voucherExtra = requests ? { specialRequests: { items: specialRequestLabels(requests), ...(requests.note ? { note: requests.note } : {}), ...(requests.arrivalTime ? { arrivalTime: requests.arrivalTime } : {}) } } : {}
      // Finding F13: the voucher shows the terms frozen at booking; only a booking made before they were frozen reads the plan's live rules.
      const frozen = readFrozenTerms(booking.cancellationPolicy)
      if (frozen.kind === 'invalid') throw new ConflictException('The frozen cancellation terms are unreadable')
      if (frozen.kind === 'frozen') return { ...base, ...voucherExtra, cancellationPolicy: frozen.rules.map(rule => ({ daysBeforeCheckin: rule.daysBeforeCheckin, penalty: rule.penaltyPercent !== undefined ? `${rule.penaltyPercent}% of the booking total` : `${booking.currency} ${rule.penaltyMinor?.toString() ?? '0'} (minor units)` })) }
      return { ...base, ...voucherExtra, cancellationPolicy: (plan ? rulesForPlan(plan, plan.contract.cancellationPolicies).rules : []).map(rule => ({
        daysBeforeCheckin: rule.daysBeforeCheckin,
        penalty: rule.penaltyPercent !== null ? `${rule.penaltyPercent}% of the booking total` : `${rule.currency ?? booking.currency} ${rule.penaltyMinor?.toString() ?? '0'} (minor units)`,
      })) }
    }
    const total = booking.totalMinor.toString()
    if (type === 'INVOICE') {
      return { ...base, currency: booking.currency, lines: [{ description: `Accommodation — ${room.name}, ${board.name}, ${nights} night${nights === 1 ? '' : 's'} × ${s.rooms} room${s.rooms === 1 ? '' : 's'}`, amountMinor: total }], totalMinor: total, payment: { method: 'wallet', status: 'PAID' } }
    }
    const cancellation = await tx.cancellation.findUnique({ where: { bookingId: booking.id } })
    if (!cancellation) throw new ConflictException('Cancellation record is missing')
    const refund = cancellation.refundMinor ?? 0n
    return { ...base, currency: booking.currency, originalInvoiceNumber: `${PREFIX.INVOICE}-${booking.reference}`, totalMinor: total, penaltyMinor: (booking.totalMinor - refund).toString(), refundMinor: refund.toString(), cancelledAt: cancellation.createdAt.toISOString() }
  }
}

/** Guests grouped by room for the voucher, lead guest first. Rooms recorded before ADR 0066 (no room number) are room 1. */
function guestRooms(guests: Array<{ roomNumber: number | null; title: string | null; firstName: string; lastName: string; type: string; age: number | null; isLead: boolean }>) {
  const rooms = new Map<number, Array<{ name: string; type: string; age: number | null; isLead: boolean }>>()
  for (const g of guests) {
    const room = g.roomNumber ?? 1
    rooms.set(room, [...(rooms.get(room) ?? []), { name: [g.title, g.firstName, g.lastName].filter(Boolean).join(' '), type: g.type, age: g.age, isLead: g.isLead }])
  }
  return [...rooms.entries()].sort(([a], [b]) => a - b).map(([room, list]) => ({ room, guests: list }))
}
