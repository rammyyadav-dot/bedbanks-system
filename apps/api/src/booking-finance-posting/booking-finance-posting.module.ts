import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApprovalsModule } from '../approvals/approvals.module'
import { BookingFinancePostingBacklogService } from './booking-finance-posting-backlog.service'
import { BookingFinancePostingController } from './booking-finance-posting.controller'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'
import { SupplierTermsController } from './supplier-terms.controller'
import { SupplierTermsService } from './supplier-terms.service'
import { SupplierSettlementController } from './supplier-settlement.controller'
import { SupplierSettlementService } from './supplier-settlement.service'
import { BookingPayablesService } from './booking-payables.service'
import { BookingRevenueService } from './booking-revenue.service'
import { BookingFinancePostingService } from './booking-finance-posting.service'
import { BookingFinancePostingWorker } from './booking-finance-posting.worker'

/** The Finance consumer of BookingFinanceEvent and its read-only backlog (ADR 0076). Posting is off unless its flags and its own database role are configured. */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [BookingFinancePostingController, SupplierSettlementController, SupplierTermsController],
  providers: [BookingFinancePostingDatabase, BookingFinancePostingService, BookingFinancePostingBacklogService, BookingRevenueService, BookingPayablesService, SupplierSettlementService, SupplierTermsService, BookingFinancePostingWorker],
  exports: [BookingFinancePostingService],
})
export class BookingFinancePostingModule {}
