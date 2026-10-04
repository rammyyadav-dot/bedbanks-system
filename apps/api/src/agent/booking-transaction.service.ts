import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { BookingConfirmationService } from './booking-confirmation.service'
import { SupplierPrebookOrchestrationService } from './supplier-prebook-orchestration.service'

/** Booking is a financial capability: it stays off unless an operator explicitly sets BOOKING_ENABLED=true. */
export function bookingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BOOKING_ENABLED === 'true'
}

export interface PrebookInput {
  tenantId: string; userId: string; requestId: string
  inventoryHoldId: string; idempotencyKey: string
  adults: number; children: number; childAges: number[]
  leadGuest: { firstName: string; lastName: string }
}

/**
 * HTTP-facing booking steps. Everything authoritative (offer, dates, rooms, price, currency) is read from the
 * server-side inventory hold; the client supplies only the hold id, an idempotency key, guests and occupancy.
 * The wallet is the tenant's wallet in the hold's currency, never a client-chosen id.
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
      // ADR 0028 slice 1: holds and bookings still post to the tenant HOUSE account (agencyId null), never an agency account.
      const wallet = await tx.wallet.findFirst({ where: { tenantId: input.tenantId, agencyId: null, currency: hold.currency } })
      if (!wallet) throw new ConflictException('Wallet is unavailable')
      const plan = await tx.ratePlan.findFirst({ where: { id: hold.ratePlanId, tenantId: input.tenantId }, include: { roomType: true } })
      if (!plan) throw new ConflictException('Rate plan is unavailable')
      return { hold, wallet, plan }
    })
    const guests = input.adults + input.children
    if (guests !== plan.occupancy || input.adults > plan.roomType.maxAdults || input.children > plan.roomType.maxChildren || input.childAges.length !== input.children) {
      throw new BadRequestException('Guest occupancy does not match the held rate')
    }
    const iso = (value: Date) => value.toISOString().slice(0, 10)
    const total = Number(hold.sellAmountMinor)
    if (!Number.isSafeInteger(total)) throw new ConflictException('Hold amount cannot be represented safely')
    return this.prebookFlow.execute({
      tenantId: input.tenantId, userId: input.userId, requestId: input.requestId, idempotencyKey: input.idempotencyKey,
      offerId: hold.offerId, searchId: hold.searchId, inventoryHoldId: hold.id,
      canonicalHotelId: hold.canonicalHotelId, canonicalRoomTypeId: hold.canonicalRoomTypeId, ratePlanId: hold.ratePlanId, boardBasisId: hold.boardBasisId,
      checkIn: iso(hold.checkIn), checkOut: iso(hold.checkOut), rooms: hold.rooms, adults: input.adults, children: input.children, childAges: input.childAges,
      currency: hold.currency, totalMinor: total, leadGuest: input.leadGuest, walletId: wallet.id,
    })
  }

  confirm(input: { tenantId: string; userId: string; requestId: string; bookingId: string }) {
    return this.confirmation.confirm(input)
  }
}
