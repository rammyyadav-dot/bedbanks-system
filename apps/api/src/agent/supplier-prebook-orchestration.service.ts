import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common'
import type { BookingTransactionCommand } from '@bedbanks/domain'
import { BookingPersistenceService } from './booking-persistence.service'
import { BookingFinancialAuthorizationService } from './booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from './prebook-compensation-recovery.service'
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
    private readonly recovery: PrebookCompensationRecoveryService,
    private readonly holds: InventoryHoldService,
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
  ) {}

  async execute(command: SupplierPrebookCommand) {
    const booking = await this.bookings.persistPending(command)
    // Claim the hold before any money moves: it must still be HELD and unexpired, and once PROCESSING
    // the expiry sweeper can no longer release it during the supplier call.
    await this.holds.beginProcessing(command.tenantId, command.inventoryHoldId, command.requestId, command.userId)
    const financeCommand = {
      tenantId: command.tenantId, userId: command.userId, requestId: command.requestId,
      walletId: command.walletId, bookingId: booking.id, currency: command.currency,
      amountMinor: BigInt(command.totalMinor), idempotencyKey: `booking:${booking.id}:authorize`,
    }
    try {
      await this.finance.authorize(financeCommand)
    } catch (error) {
      // Nothing was reserved, so only the claimed inventory needs returning (e.g. insufficient credit).
      await this.holds.release(command.tenantId, command.inventoryHoldId, `${command.requestId}:authorize-failed`, { type: 'USER', userId: command.userId })
      throw error
    }

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
      const compensation = await this.recovery.compensate({ ...financeCommand, inventoryHoldId: command.inventoryHoldId })
      if (compensation.status === 'reconciliation_required') {
        throw new ServiceUnavailableException('Supplier prebook failed and compensation requires reconciliation')
      }
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }
  }
}
