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
import {
  SupplierMutationJournalService,
  supplierMutationAcceptedReference,
  supplierMutationFingerprint,
  type SupplierMutationView,
} from './supplier-mutation-journal.service'

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
    private readonly journal: SupplierMutationJournalService,
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

    const recorded = await this.journal.findForBooking(command.tenantId, booking.id, 'PREBOOK')
    const alreadyAccepted = supplierMutationAcceptedReference(recorded)
    if (alreadyAccepted) {
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'PREBOOKED')
      return { status: 'prebooked' as const, bookingId: booking.id, bookingReference: booking.reference, supplierReference: alreadyAccepted }
    }
    if (recorded && (recorded.status === 'SENDING' || recorded.status === 'UNKNOWN')) {
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
      throw new ServiceUnavailableException('Supplier prebook outcome is unknown')
    }
    if (recorded && (recorded.status === 'REJECTED' || recorded.status === 'RESOLVED')) {
      throw new ServiceUnavailableException('Supplier prebook unavailable')
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

    const idempotencyKey = `booking:${booking.id}:prebook`
    let mutation: SupplierMutationView
    try {
      mutation = await this.journal.prepare({
        tenantId: command.tenantId,
        userId: command.userId,
        bookingId: booking.id,
        holdId: command.inventoryHoldId,
        supplierKey: this.supplierKey(),
        operation: 'PREBOOK',
        idempotencyKey,
        requestId: command.requestId,
        fingerprint: supplierMutationFingerprint({
          offerId: command.offerId, searchId: command.searchId, holdId: command.inventoryHoldId,
          checkIn: command.checkIn, checkOut: command.checkOut, rooms: command.rooms,
          adults: command.adults, children: command.children, currency: command.currency, totalMinor: command.totalMinor,
        }),
      })
    } catch (error) {
      // The supplier was not called. Returning the local reservation is safe.
      this.logger.error(`Supplier mutation prepare failed booking=${booking.id} request=${command.requestId} error=${error instanceof Error ? error.name : 'UnknownError'}`)
      await this.compensateOrThrow(financeCommand, command.inventoryHoldId)
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }

    const preparedAccepted = supplierMutationAcceptedReference(mutation)
    if (preparedAccepted) {
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'PREBOOKED')
      return { status: 'prebooked' as const, bookingId: booking.id, bookingReference: booking.reference, supplierReference: preparedAccepted }
    }
    if (mutation.status === 'SENDING' || mutation.status === 'UNKNOWN') {
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
      throw new ServiceUnavailableException('Supplier prebook outcome is unknown')
    }
    if (mutation.status !== 'PREPARED') {
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }

    let claim: { claimed: boolean; record: SupplierMutationView }
    try {
      claim = await this.journal.markSending(command.tenantId, mutation.id, command.requestId, command.userId)
    } catch (error) {
      const current = await this.journal.findById(command.tenantId, mutation.id).catch(() => undefined)
      const accepted = current ? supplierMutationAcceptedReference(current) : null
      if (current === undefined || current?.status === 'SENDING' || current?.status === 'UNKNOWN') {
        // The outbound write may have committed, or its result cannot be read. Do not treat that as not-sent.
        assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
        throw new ServiceUnavailableException('Supplier prebook outcome is unknown')
      }
      if (accepted) {
        assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'PREBOOKED')
        return { status: 'prebooked' as const, bookingId: booking.id, bookingReference: booking.reference, supplierReference: accepted }
      }
      this.logger.error(`Supplier mutation sending transition failed booking=${booking.id} mutation=${mutation.id} request=${command.requestId} error=${error instanceof Error ? error.name : 'UnknownError'}`)
      await this.compensateOrThrow(financeCommand, command.inventoryHoldId)
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }
    if (!claim.claimed) {
      const accepted = supplierMutationAcceptedReference(claim.record)
      if (accepted) {
        assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'PREBOOKED')
        return { status: 'prebooked' as const, bookingId: booking.id, bookingReference: booking.reference, supplierReference: accepted }
      }
      if (claim.record.status === 'SENDING' || claim.record.status === 'UNKNOWN') {
        assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
        throw new ServiceUnavailableException('Supplier prebook outcome is unknown')
      }
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }

    let prebook: { supplierReference: string }
    try {
      prebook = await this.supplier.prebook(
        { offerId: command.offerId, searchId: command.searchId, idempotencyKey },
        { tenantId: command.tenantId, userId: command.userId, requestId: command.requestId },
      )
    } catch (error) {
      if (this.uncertain(error)) {
        assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
        await this.journal.markUnknown({
          tenantId: command.tenantId, userId: command.userId, mutationId: mutation.id,
          failureCategory: error.code, failureCode: error.code,
        }).catch(() => this.logger.error(`Could not mark supplier mutation unknown booking=${booking.id} mutation=${mutation.id}`))
        await this.retainUnknown(command, booking.id, error.code)
        throw new ServiceUnavailableException('Supplier prebook outcome is unknown')
      }
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'FAILED')
      const failureCode = error instanceof SupplierProviderError ? error.code : 'rejected'
      await this.journal.reject({
        tenantId: command.tenantId, userId: command.userId, mutationId: mutation.id,
        failureCategory: 'supplier_rejection', failureCode,
      }).catch(() => this.logger.error(`Could not mark supplier mutation rejected booking=${booking.id} mutation=${mutation.id}`))
      await this.compensateOrThrow(financeCommand, command.inventoryHoldId)
      throw new ServiceUnavailableException('Supplier prebook unavailable')
    }

    try {
      await this.journal.acknowledge({
        tenantId: command.tenantId, userId: command.userId, mutationId: mutation.id, supplierReference: prebook.supplierReference,
      })
    } catch {
      // The supplier may have accepted. SENDING remains if this write fails. Do not compensate.
      assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'UNKNOWN')
      await this.journal.markUnknown({
        tenantId: command.tenantId, userId: command.userId, mutationId: mutation.id,
        failureCategory: 'ack_persistence', failureCode: 'ack_write_failed',
      }).catch(() => this.logger.error(`Supplier acknowledgement was not durable booking=${booking.id} mutation=${mutation.id} request=${command.requestId}`))
      throw new ServiceUnavailableException('Supplier prebook requires reconciliation')
    }

    assertBookingTransactionTransition('FINANCE_AUTHORIZED', 'PREBOOKED')
    await this.retainPrebook(command, booking.id, prebook.supplierReference)
    return {
      status: 'prebooked' as const,
      bookingId: booking.id,
      bookingReference: booking.reference,
      supplierReference: prebook.supplierReference,
    }
  }

  private supplierKey(): string {
    return typeof this.supplier.name === 'string' && this.supplier.name.length > 0 ? this.supplier.name : 'unconfigured'
  }

  private async compensateOrThrow(financeCommand: { tenantId: string; userId: string; requestId: string; walletId: string; bookingId: string; currency: string; amountMinor: bigint; idempotencyKey: string }, inventoryHoldId: string): Promise<void> {
    const compensation = await this.recovery.compensate({ ...financeCommand, inventoryHoldId })
    if (compensation.status === 'reconciliation_required') {
      throw new ServiceUnavailableException('Supplier prebook failed and compensation requires reconciliation')
    }
  }

  private uncertain(error: unknown): error is SupplierProviderError & { code: UncertainSupplierCode } {
    return error instanceof SupplierProviderError && (error.code === 'timeout' || error.code === 'transport')
  }

  /** Supplier reference is already durable in the journal. Booking and audit copies are additional. */
  private async retainPrebook(command: SupplierPrebookCommand, bookingId: string, supplierReference: string): Promise<void> {
    try {
      await this.bookings.recordSupplierPrebook(command.tenantId, bookingId, { outcome: 'prebooked', supplierReference })
    } catch {
      this.logger.error(`Could not persist supplier prebook booking=${bookingId} request=${command.requestId}`)
    }
    try {
      await this.audit.record({ tenantId: command.tenantId, userId: command.userId, action: 'booking.prebook.succeeded', entityType: 'booking', entityId: bookingId,
        payload: { requestId: command.requestId, inventoryHoldId: command.inventoryHoldId, supplierReference } })
    } catch {
      this.logger.error(`Could not record prebook success booking=${bookingId} request=${command.requestId}`)
    }
  }

  /**
   * Timeout or transport loss. Inventory and the finance reservation stay claimed.
   * The journal SENDING/UNKNOWN row is the durable evidence; these copies are additional.
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
