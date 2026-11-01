import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { bookingAccountFor } from './agency-account'
import { BookingConfirmationService } from './booking-confirmation.service'
import { SupplierPrebookOrchestrationService } from './supplier-prebook-orchestration.service'
import { normalizeCheckout } from './checkout-details'
import type { CheckoutGuest, CheckoutSpecialRequests, DuplicateBookingMatch } from '@bedbanks/contracts'

/** Booking is a financial capability: it stays off unless an operator explicitly sets BOOKING_ENABLED=true. */
export function bookingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BOOKING_ENABLED === 'true'
}

/**
 * Serving bookings that already exist (list, detail, documents, cancellation quote and cancel). On whenever booking is enabled, and separately switchable with
 * BOOKING_SERVICING_ENABLED=true so that closing new sales (BOOKING_ENABLED off) does not strand agents who hold vouchers or must cancel (ADR 0101).
 */
export function bookingServicingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return bookingEnabled(env) || env.BOOKING_SERVICING_ENABLED === 'true'
}

export interface PrebookInput {
  tenantId: string; userId: string; requestId: string
  inventoryHoldId: string; idempotencyKey: string
  adults: number; children: number; childAges: number[]
  leadGuest: { firstName: string; lastName: string }
  /** ADR 0066 checkout details; all optional and non-commercial. */
  guests?: CheckoutGuest[]; agentRef?: string; specialRequests?: CheckoutSpecialRequests
}

/** Statuses of a booking that still stands: a second booking for the same guest, hotel and dates is then probably a mistake. */
const ACTIVE_STATUSES = ['PENDING_SUPPLIER', 'ON_REQUEST', 'CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED'] as const

/**
 * HTTP-facing booking steps. Everything authoritative (offer, dates, rooms, price, currency) is read from the
 * server-side inventory hold; the client supplies only the hold id, an idempotency key, guests and occupancy.
 * The account is the booker's agency account in the hold's currency (ADR 0028 slice 3), never a client-chosen id.
 */
@Injectable()
export class BookingTransactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prebookFlow: SupplierPrebookOrchestrationService,
    private readonly confirmation: BookingConfirmationService,
  ) {}

  async prebook(input: PrebookInput) {
    const { hold, wallet, plan } = await this.prisma.withTenant(input.tenantId, async tx => {
      const hold = await tx.inventoryHold.findFirst({ where: { id: input.inventoryHoldId, tenantId: input.tenantId, createdByUserId: input.userId } })
      if (!hold) throw new ConflictException('Inventory hold is unavailable')
      // ADR 0028 slice 3: a booking is charged to the booker's AGENCY account (opened if needed); a user in no agency cannot book.
      const wallet = await bookingAccountFor(tx, input.tenantId, input.userId, hold.currency)
      const plan = await tx.ratePlan.findFirst({ where: { id: hold.ratePlanId, tenantId: input.tenantId }, include: { roomType: true } })
      if (!plan) throw new ConflictException('Rate plan is unavailable')
      return { hold, wallet, plan }
    })
    const guests = input.adults + input.children
    if (guests !== plan.occupancy || input.adults > plan.roomType.maxAdults || input.children > plan.roomType.maxChildren || input.childAges.length !== input.children) {
      throw new BadRequestException('Guest occupancy does not match the held rate')
    }
    const details = normalizeCheckout(input, { rooms: hold.rooms, adults: input.adults, children: input.children, childAges: input.childAges, leadGuest: input.leadGuest })
    const iso = (value: Date) => value.toISOString().slice(0, 10)
    const total = Number(hold.sellAmountMinor)
    if (!Number.isSafeInteger(total)) throw new ConflictException('Hold amount cannot be represented safely')
    return this.prebookFlow.execute({
      tenantId: input.tenantId, userId: input.userId, requestId: input.requestId, idempotencyKey: input.idempotencyKey,
      offerId: hold.offerId, searchId: hold.searchId, inventoryHoldId: hold.id,
      canonicalHotelId: hold.canonicalHotelId, canonicalRoomTypeId: hold.canonicalRoomTypeId, ratePlanId: hold.ratePlanId, boardBasisId: hold.boardBasisId,
      checkIn: iso(hold.checkIn), checkOut: iso(hold.checkOut), rooms: hold.rooms, adults: input.adults, children: input.children, childAges: input.childAges,
      currency: hold.currency, totalMinor: total, leadGuest: input.leadGuest, walletId: wallet.id,
      ...(details.agentRef ? { agencyReference: details.agentRef } : {}),
      ...(details.specialRequests ? { specialRequests: details.specialRequests } : {}),
      ...(details.guests ? { guests: details.guests } : {}),
    })
  }

  /**
   * ADR 0066 amendment 1: the duplicate-booking check global bedbanks run before a portal booking. Same agency, hotel, dates and lead guest,
   * still active, and not this very prebook (a retry carries the same idempotency key). A warning the agent may override, not a constraint:
   * only the agent portal's prebook asks, so other channels are unaffected. Only references leave this query, never guest data.
   * An unknown hold or a user outside any agency finds nothing here; prebook then refuses it with its own error.
   */
  async findDuplicates(input: { tenantId: string; userId: string; inventoryHoldId: string; idempotencyKey: string; leadGuest: { firstName: string; lastName: string } }): Promise<DuplicateBookingMatch[]> {
    return this.prisma.withTenant(input.tenantId, async tx => {
      const hold = await tx.inventoryHold.findFirst({ where: { id: input.inventoryHoldId, tenantId: input.tenantId, createdByUserId: input.userId }, select: { canonicalHotelId: true, checkIn: true, checkOut: true } })
      const member = await tx.agencyMember.findFirst({ where: { tenantId: input.tenantId, userId: input.userId }, select: { agencyId: true } })
      if (!hold || !member) return []
      const rows = await tx.booking.findMany({
        where: { tenantId: input.tenantId, agencyId: member.agencyId, hotelId: hold.canonicalHotelId, checkIn: hold.checkIn, checkOut: hold.checkOut,
          status: { in: [...ACTIVE_STATUSES] }, idempotencyKey: { not: input.idempotencyKey },
          guests: { some: { isLead: true, firstName: { equals: input.leadGuest.firstName.trim(), mode: 'insensitive' }, lastName: { equals: input.leadGuest.lastName.trim(), mode: 'insensitive' } } } },
        select: { reference: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 3,
      })
      return rows.map((d): DuplicateBookingMatch => ({ reference: d.reference, status: d.status, createdAt: d.createdAt.toISOString() }))
    })
  }

  confirm(input: { tenantId: string; userId: string; requestId: string; bookingId: string; recipient?: string | null; cc?: string[] }) {
    return this.confirmation.confirm(input)
  }
}
