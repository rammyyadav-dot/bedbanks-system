import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { moveNight } from '../inventory/inventory-counters'
import { readSupplierPrebook } from './supplier-prebook-record'
import { supplierMutationAcceptedReference } from './supplier-mutation-journal.service'

export interface BookingConfirmationCommand { tenantId: string; userId: string; requestId: string; bookingId: string }
export interface BookingConfirmationResult { bookingId: string; reference: string; status: 'CONFIRMED'; alreadyConfirmed: boolean }

/**
 * Confirms a prebooked booking against contracted (in-house) inventory in ONE database transaction:
 * hold PROCESSING -> CONFIRMED, held -> sold on every night, wallet reservation converted to a final DEBIT,
 * booking PENDING -> CONFIRMED, audit. Either all of it commits or none of it does, so no outcome can
 * double-sell a room or charge twice. Idempotent: confirming a confirmed booking returns it unchanged.
 */
@Injectable()
export class BookingConfirmationService {
  constructor(private readonly prisma: PrismaService) {}

  async confirm(command: BookingConfirmationCommand): Promise<BookingConfirmationResult> {
    const { tenantId, userId, requestId, bookingId } = command
    return this.prisma.withTenant(tenantId, async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (locked.length !== 1) throw new NotFoundException('Booking not found')
      const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId } })
      if (booking.status === 'CONFIRMED') return { bookingId, reference: booking.reference, status: 'CONFIRMED' as const, alreadyConfirmed: true }
      if (booking.status !== 'PENDING') throw new ConflictException('Booking is not confirmable')

      const mutation = await tx.supplierMutation.findFirst({ where: { tenantId, bookingId, operation: 'PREBOOK' }, orderBy: { createdAt: 'desc' } })
      if (mutation) {
        if (mutation.status === 'SENDING' || mutation.status === 'UNKNOWN' || (mutation.status === 'RESOLVED' && mutation.supplierStatus === 'unknown')) {
          throw new ConflictException('Supplier outcome is unknown')
        }
        if (!supplierMutationAcceptedReference(mutation)) throw new ConflictException('Booking has not been prebooked')
      } else {
        const prebooked = await tx.auditEvent.count({ where: { tenantId, action: 'booking.prebook.succeeded', entityType: 'booking', entityId: bookingId } })
        const recorded = readSupplierPrebook(booking.searchSnapshot)
        if (recorded?.outcome === 'unknown' && prebooked === 0) throw new ConflictException('Supplier outcome is unknown')
        const durablePrebook = recorded?.outcome === 'prebooked' && typeof recorded.supplierReference === 'string'
        if (prebooked === 0 && !durablePrebook) throw new ConflictException('Booking has not been prebooked')
      }

      const holdId = (booking.searchSnapshot as { inventoryHoldId?: unknown } | null)?.inventoryHoldId
      if (typeof holdId !== 'string') throw new ConflictException('Booking has no inventory hold')
      const heldRows = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`SELECT "id", "status"::text AS "status" FROM "InventoryHold" WHERE "id" = ${holdId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (heldRows.length !== 1 || heldRows[0].status !== 'PROCESSING') throw new ConflictException('Inventory hold is no longer active')

      const authorizationKey = `booking:${bookingId}:authorize`
      const reservation = await tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: authorizationKey, type: 'HOLD' } })
      if (!reservation) throw new ConflictException('Financial authorization is unavailable')
      const amountMinor = -reservation.amountMinor
      if (amountMinor !== booking.totalMinor || reservation.currency !== booking.currency) throw new ConflictException('Financial authorization does not match the booking')
      const walletRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "id" = ${reservation.walletId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (walletRows.length !== 1) throw new ForbiddenException('Wallet is unavailable')

      const nights = await tx.inventoryHoldNight.findMany({ where: { holdId, tenantId } })
      if (nights.length === 0) throw new ConflictException('Inventory hold has no nights')
      for (const night of nights) await moveNight(tx, tenantId, night, 'confirm')
      await tx.inventoryHold.update({ where: { id: holdId }, data: { status: 'CONFIRMED' } })

      // The reservation becomes a final charge: reverse the HOLD, then DEBIT the same amount (net balance unchanged).
      const reference = `booking:${bookingId}`
      await tx.ledgerEntry.create({ data: { tenantId, walletId: reservation.walletId, type: 'RELEASE', amountMinor, currency: booking.currency, reference, idempotencyKey: `${authorizationKey}:settle-release` } })
      await tx.ledgerEntry.create({ data: { tenantId, walletId: reservation.walletId, type: 'DEBIT', amountMinor: -amountMinor, currency: booking.currency, reference, idempotencyKey: `${authorizationKey}:settle-debit` } })

      await tx.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED', supplier: 'contracted-inventory' } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'booking.confirmed', entityType: 'booking', entityId: bookingId,
        payload: { requestId, inventoryHoldId: holdId, walletId: reservation.walletId, currency: booking.currency, amountMinor: amountMinor.toString() } } })
      return { bookingId, reference: booking.reference, status: 'CONFIRMED' as const, alreadyConfirmed: false }
    })
  }
}
