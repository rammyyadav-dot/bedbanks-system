import { Injectable } from '@nestjs/common'
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
  constructor(
    private readonly finance: BookingFinancialAuthorizationService,
    private readonly inventory: InventoryHoldService,
  ) {}

  async compensate(command: PrebookCompensationCommand): Promise<PrebookCompensationResult> {
    let financeReleased = false
    let inventoryReleased = false

    try {
      await this.finance.release(command)
      financeReleased = true
    } catch {
      // Retryable: the caller receives reconciliation_required and may safely invoke this command again.
    }

    try {
      await this.inventory.release(
        command.tenantId,
        command.inventoryHoldId,
        `${command.requestId}:prebook-compensation`,
        { type: 'USER', userId: command.userId },
      )
      inventoryReleased = true
    } catch {
      // Inventory release is idempotent; a later recovery pass may safely retry it.
    }

    return financeReleased && inventoryReleased
      ? { status: 'compensated', financeReleased: true, inventoryReleased: true }
      : { status: 'reconciliation_required', financeReleased, inventoryReleased }
  }
}
