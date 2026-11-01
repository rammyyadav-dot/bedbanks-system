import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { LedgerAdjustmentController } from './ledger-adjustment.controller'
import { LedgerAdjustmentService } from './ledger-adjustment.service'

/** Ledger adjustments and reversals on agency accounts (ADR 0100). */
@Module({ imports: [AuthModule], controllers: [LedgerAdjustmentController], providers: [LedgerAdjustmentService] })
export class FinanceAdjustmentsModule {}
