import { Injectable, Logger } from '@nestjs/common'
import { AgentAuditService } from './audit.service'
import { BookingFinancialAuthorizationService, type FinancialAuthorizationCommand } from './booking-financial-authorization.service'
import { InventoryHoldService } from './inventory-hold.service'

export interface PrebookCompensationCommand extends FinancialAuthorizationCommand {
  inventoryHoldId: string
}

export type PrebookCompensationResult =
  | { status: 'compensated'; financeReleased: true; inventoryReleased: true }
  | { status: 'reconciliation_required'; financeReleased: boolean; inventoryReleased: boolean }

@Injectable()
export class PrebookCompensationRecoveryService {
  private readonly logger = new Logger(PrebookCompensationRecoveryService.name)

  constructor(
    private readonly finance: BookingFinancialAuthorizationService,
    private readonly inventory: InventoryHoldService,
    private readonly audit: AgentAuditService,
  ) {}

  async compensate(command: PrebookCompensationCommand): Promise<PrebookCompensationResult> {
    let financeReleased = false
    let inventoryReleased = false

    try {
      await this.finance.release(command)
      financeReleased = true
    } catch (error) {
      // Retryable: the caller receives reconciliation_required and the reconciliation sweep will retry.
      await this.recordFailure(command, 'finance_release', error)
    }

    try {
      await this.inventory.release(
        command.tenantId,
        command.inventoryHoldId,
        `${command.requestId}:prebook-compensation`,
        { type: 'USER', userId: command.userId },
      )
      inventoryReleased = true
    } catch (error) {
      // Inventory release is idempotent; the reconciliation sweep may safely retry it.
      await this.recordFailure(command, 'inventory_release', error)
    }

    if (financeReleased && inventoryReleased) return { status: 'compensated', financeReleased: true, inventoryReleased: true }
    await this.recordFailure(command, 'reconciliation_required', undefined, { financeReleased, inventoryReleased })
    return { status: 'reconciliation_required', financeReleased, inventoryReleased }
  }

  /** Observable but never throwing, and never carrying guest data, amounts' owners or raw error messages. */
  private async recordFailure(command: PrebookCompensationCommand, leg: string, error?: unknown, extra: Record<string, unknown> = {}) {
    const errorName = error instanceof Error ? error.name : error === undefined ? undefined : 'UnknownError'
    this.logger.error(`Prebook compensation ${leg} failed booking=${command.bookingId} hold=${command.inventoryHoldId} request=${command.requestId}${errorName ? ` error=${errorName}` : ''}`)
    try {
      await this.audit.record({
        tenantId: command.tenantId, userId: command.userId, action: leg === 'reconciliation_required' ? 'booking.compensation.reconciliation_required' : 'booking.compensation.failed',
        entityType: 'booking', entityId: command.bookingId,
        payload: { leg, requestId: command.requestId, inventoryHoldId: command.inventoryHoldId, walletId: command.walletId, ...(errorName ? { errorName } : {}), ...extra },
      })
    } catch {
      this.logger.error(`Could not audit compensation failure booking=${command.bookingId} leg=${leg}`)
    }
  }
}
