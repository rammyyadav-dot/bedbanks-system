import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import type { BookingTransactionCommand } from '@bedbanks/domain'
import { BookingPersistenceService } from './booking-persistence.service'
import { BookingFinancialAuthorizationService } from './booking-financial-authorization.service'
import { PrebookCompensationRecoveryService } from './prebook-compensation-recovery.service'
import { InventoryHoldService } from './inventory-hold.service'
import { AgentAuditService } from './audit.service'
import { assertBookingTransactionTransition } from './booking-transaction-state'
import { readSupplierPrebook, type UncertainSupplierCode } from './supplier-prebook-record'
import { SUPPLIER_ADAPTER, SupplierProviderError, type SupplierAdapter } from './supplier.port'

export interface SupplierPrebookCommand extends BookingTransactionCommand {
  walletId: string
}

@Injectable()
export class SupplierPrebookOrchestrationService {
  private readonly logger = new Logger(SupplierPrebookOrchestrationService.name)

  constructor(
    private readonly bookings: BookingPersistenceService,
    private readonly finance: BookingFinancialAuthorizationService,
    private readonly recovery: PrebookCompensationRecoveryService,
    private readonly holds: InventoryHoldService,
    private readonly audit: AgentAuditService,
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
  ) {}

  async execute(command: SupplierPrebookCommand) {
    const booking = await this.bookings.persistPending(command)
    const prior = readSupplierPrebook(booking.searchSnapshot)
    if (prior?.outcome === 'prebooked' && prior.supplierReference) {
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'PREBOOKED')
      return { status: 'prebooked' as const, bookingId: booking.id, bookingReference: booking.reference, supplierReference: prior.supplierReference }
    }
    if (prior?.outcome === 'unknown') {
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
      throw new ServiceUnavailableException('Supplier prebook outcome is unknown')
    }

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

    let prebook: { supplierReference: string }
    try {
      prebook = await this.supplier.prebook(
        { offerId: command.offerId, searchId: command.searchId, idempotencyKey: `booking:${booking.id}:prebook` },
        { tenantId: command.tenantId, userId: command.userId, requestId: command.requestId },
      )
    } catch (error) {
      if (this.uncertain(error)) {
        assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
        await this.retainUnknown(command, booking.id, error.code)
        throw new ServiceUnavailableException('Supplier prebook outcome is unknown')
      }
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'FAILED')
      const compensation = await this.recovery.compensate({ ...financeCommand, inventoryHoldId: command.inventoryHoldId })
      if (compensation.status === 'reconciliation_required') {
        throw new ServiceUnavailableException('Supplier prebook failed and compensation requires reconciliation')
      }
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }

    assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'PREBOOKED')
    const recorded = await this.retainPrebook(command, booking.id, prebook.supplierReference)
    if (!recorded) {
      await this.retainUnknown(command, booking.id, undefined, prebook.supplierReference)
      throw new ServiceUnavailableException('Supplier prebook requires reconciliation')
    }
    return {
      status: 'prebooked' as const,
      bookingId: booking.id,
      bookingReference: booking.reference,
      supplierReference: prebook.supplierReference,
    }
  }

  private uncertain(error: unknown): error is SupplierProviderError & { code: UncertainSupplierCode } {
    return error instanceof SupplierProviderError && (error.code === 'timeout' || error.code === 'transport')
  }

  /** Supplier returned a reference. Keep the hold and the finance reservation until a durable copy exists. */
  private async retainPrebook(command: SupplierPrebookCommand, bookingId: string, supplierReference: string): Promise<boolean> {
    let durable = false
    try {
      await this.bookings.recordSupplierPrebook(command.tenantId, bookingId, { outcome: 'prebooked', supplierReference })
      durable = true
    } catch {
      this.logger.error(`Could not persist supplier prebook booking=${bookingId} request=${command.requestId}`)
    }
    try {
      await this.audit.record({ tenantId: command.tenantId, userId: command.userId, action: 'booking.prebook.succeeded', entityType: 'booking', entityId: bookingId,
        payload: { requestId: command.requestId, inventoryHoldId: command.inventoryHoldId, supplierReference } })
      durable = true
    } catch {
      this.logger.error(`Could not record prebook success booking=${bookingId} request=${command.requestId}`)
    }
    if (!durable) this.logger.error(`Supplier prebook reference retained only in process booking=${bookingId} request=${command.requestId} supplierReference=${supplierReference}`)
    return durable
  }

  /**
   * Timeout, transport loss, or a supplier success whose local write failed.
   * Inventory and the finance reservation stay claimed so a later proof cannot oversell.
   */
  private async retainUnknown(command: SupplierPrebookCommand, bookingId: string, code?: UncertainSupplierCode, supplierReference?: string): Promise<void> {
    const payload = {
      requestId: command.requestId, inventoryHoldId: command.inventoryHoldId,
      ...(code ? { code } : {}),
      ...(supplierReference ? { supplierReference } : {}),
    }
    try {
      await this.bookings.recordSupplierPrebook(command.tenantId, bookingId, { outcome: 'unknown', ...(code ? { code } : {}), ...(supplierReference ? { supplierReference } : {}) })
    } catch {
      this.logger.error(`Could not persist unknown supplier outcome booking=${bookingId} request=${command.requestId}${code ? ` code=${code}` : ''}`)
    }
    try {
      await this.audit.record({ tenantId: command.tenantId, userId: command.userId, action: 'booking.prebook.unknown', entityType: 'booking', entityId: bookingId, payload })
    } catch {
      this.logger.error(`Could not audit unknown supplier outcome booking=${bookingId} request=${command.requestId}${code ? ` code=${code}` : ''}`)
    }
  }
}
