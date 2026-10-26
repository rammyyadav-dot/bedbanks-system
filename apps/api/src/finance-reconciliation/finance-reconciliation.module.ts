import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApprovalsModule } from '../approvals/approvals.module'
import { BankReconciliationController } from './bank-reconciliation.controller'
import { BankReconciliationService } from './bank-reconciliation.service'
import { FinanceReconciliationController } from './finance-reconciliation.controller'
import { ReconciliationRunner } from './reconciliation-runner.service'
import { ReconciliationService } from './reconciliation.service'
import { ReconciliationWorker } from './reconciliation-worker.service'
import { ReconciliationDatabase, ReconciliationStore } from './reconciliation-store'

/** Supplier statement reconciliation and the dispute queue (ADR 0070), and bank statement reconciliation (ADR 0093). */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [FinanceReconciliationController, BankReconciliationController],
  providers: [ReconciliationService, BankReconciliationService, ReconciliationRunner, ReconciliationWorker, ReconciliationDatabase, ReconciliationStore],
  exports: [ReconciliationRunner],
})
export class FinanceReconciliationModule {}
