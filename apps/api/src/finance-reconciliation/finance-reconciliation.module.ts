import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { FinanceReconciliationController } from './finance-reconciliation.controller'
import { ReconciliationRunner } from './reconciliation-runner.service'
import { ReconciliationService } from './reconciliation.service'
import { ReconciliationWorker } from './reconciliation-worker.service'
import { ReconciliationDatabase, ReconciliationStore } from './reconciliation-store'

/** Supplier statement reconciliation and the dispute queue (ADR 0070). */
@Module({
  imports: [AuthModule],
  controllers: [FinanceReconciliationController],
  providers: [ReconciliationService, ReconciliationRunner, ReconciliationWorker, ReconciliationDatabase, ReconciliationStore],
  exports: [ReconciliationRunner],
})
export class FinanceReconciliationModule {}
