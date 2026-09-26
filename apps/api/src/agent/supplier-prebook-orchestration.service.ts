import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common'
import type { BookingTransactionCommand } from '@bedbanks/domain'
import { BookingPersistenceService } from './booking-persistence.service'
import { BookingFinancialAuthorizationService } from './booking-financial-authorization.service'
import { InventoryHoldService } from './inventory-hold.service'
import { SUPPLIER_ADAPTER, type SupplierAdapter } from './supplier.port'

export interface SupplierPrebookCommand extends BookingTransactionCommand {
  walletId: string
}

@Injectable()
export class SupplierPrebookOrchestrationService {
  constructor(
    private readonly bookings: BookingPersistenceService,
    private readonly finance: BookingFinancialAuthorizationService,
    private readonly inventory: InventoryHoldService,
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
  ) {}

  async execute(command: SupplierPrebookCommand) {
    const booking = await this.bookings.persistPending(command)
    const financeCommand = {
      tenantId: command.tenantId, userId: command.userId, requestId: command.requestId,
      walletId: command.walletId, bookingId: booking.id, currency: command.currency,
      amountMinor: BigInt(command.totalMinor), idempotencyKey: `booking:${booking.id}:authorize`,
    }
    await this.finance.authorize(financeCommand)

    try {
      const prebook = await this.supplier.prebook(
        { offerId: command.offerId, searchId: command.searchId, idempotencyKey: `booking:${booking.id}:prebook` },
        { tenantId: command.tenantId, userId: command.userId, requestId: command.requestId },
      )
      return {
        status: 'prebooked' as const,
        bookingId: booking.id,
        bookingReference: booking.reference,
        supplierReference: prebook.supplierReference,
      }
    } catch {
      const compensationErrors: unknown[] = []
      try { await this.finance.release(financeCommand) } catch (error) { compensationErrors.push(error) }
      try {
        await this.inventory.release(command.tenantId, command.inventoryHoldId, `${command.requestId}:prebook-failed`, { type: 'USER', userId: command.userId })
      } catch (error) { compensationErrors.push(error) }

      if (compensationErrors.length > 0) {
        throw new ServiceUnavailableException('Supplier prebook failed and compensation requires reconciliation')
      }
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }
  }
}
