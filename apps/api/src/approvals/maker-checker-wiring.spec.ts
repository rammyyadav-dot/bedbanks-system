import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { CommercialController } from '../commercial/commercial.controller'
import { CommercialFxController } from '../commercial/commercial-fx.controller'
import { AgencyCreditController } from '../departments/agency-credit.controller'
import { OperationsController } from '../admin-operations/operations.controller'
import { SupplierSettlementController } from '../booking-finance-posting/supplier-settlement.controller'
import { FinanceReconciliationController } from '../finance-reconciliation/finance-reconciliation.controller'
import { BankReconciliationController } from '../finance-reconciliation/bank-reconciliation.controller'
import { FundingController } from '../funding/funding.controller'
import { DualApprovalGuard, REQUIRED_DUAL_APPROVAL, REQUIRED_STEP_UP, StepUpGuard } from './dual-approval.guard'

type Ctor = { prototype: object }
const guards = (c: Ctor, h: string) => (Reflect.getMetadata(GUARDS_METADATA, (c.prototype as Record<string, object>)[h]) ?? []) as unknown[]
const meta = (key: string, c: Ctor, h: string) => Reflect.getMetadata(key, (c.prototype as Record<string, object>)[h]) as { action: string; param: string } | undefined

/** Every finance and commercial checker decision, and every execution of an approved change, with the permission key it is audited under. */
const CHECKER_DECISIONS: Array<[Ctor, string, string, string]> = [
  [CommercialController, 'approve', 'markup.activate', 'approvalId'],
  [CommercialFxController, 'approve', 'fx.activate', 'approvalId'],
  [AgencyCreditController, 'approveCredit', 'credit_limit.approve', 'approvalId'],
  [OperationsController, 'approveReconciliation', 'reconciliation.resolve', 'approvalId'],
  [SupplierSettlementController, 'approve', 'finance.settle.approve', 'settlementId'],
  [FinanceReconciliationController, 'approve', 'finance.reconcile.resolve', 'exceptionId'],
  [BankReconciliationController, 'resolve', 'finance.reconcile.resolve', 'exceptionId'],
  [FundingController, 'post', 'funding.manage', 'receiptId'],
]
const EXECUTIONS: Array<[Ctor, string, string]> = [
  [CommercialController, 'execute', 'markup.activate'],
  [CommercialFxController, 'execute', 'fx.activate'],
  [AgencyCreditController, 'executeCredit', 'credit_limit.approve'],
  [OperationsController, 'executeReconciliationApproval', 'reconciliation.resolve'],
]

describe('maker-checker wiring on finance and commercial routes (ADR 0095)', () => {
  it.each(CHECKER_DECISIONS)('%p.%s needs the checker\'s password (%s on :%s)', (controller, handler, action, param) => {
    expect(guards(controller, handler)).toContain(StepUpGuard)
    expect(meta(REQUIRED_STEP_UP, controller, handler)).toEqual({ action, param })
  })

  it.each(EXECUTIONS)('%p.%s refuses a direct call without a second person\'s approval of %s', (controller, handler, action) => {
    expect(guards(controller, handler)).toContain(DualApprovalGuard)
    expect(meta(REQUIRED_DUAL_APPROVAL, controller, handler)).toEqual({ action, param: 'approvalId' })
  })

  it.each([...CHECKER_DECISIONS.map(([c, h]) => [c, h] as const), ...EXECUTIONS.map(([c, h]) => [c, h] as const)])('%p.%s runs the permission guard before the maker-checker guard', (controller, handler) => {
    const list = guards(controller, handler) as Array<{ name: string }>
    const at = list.findIndex((g) => g === StepUpGuard || g === DualApprovalGuard)
    expect(at).toBeGreaterThan(0)
    expect(list[at - 1].name).toMatch(/PermissionGuard|RbacGuard/)
  })
})
