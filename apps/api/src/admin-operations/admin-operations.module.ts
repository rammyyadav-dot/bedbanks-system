import { Module } from '@nestjs/common'
import { AgentModule } from '../agent/agent.module'
import { AuthModule } from '../auth/auth.module'
import { OperationsController } from './operations.controller'
import { OperationsHotelsService } from './operations-hotels.service'
import { OperationsFinanceAuditService } from './operations-finance-audit.service'
import { OperationsReconciliationApprovalsService } from './operations-reconciliation-approvals.service'
import { OperationsGovernanceService } from './operations-governance.service'
import { ApprovalsModule } from '../approvals/approvals.module'
import { OperationsSupplyService } from './operations-supply.service'
import { OperationsTransactionsService } from './operations-transactions.service'
import { OperationsBookingsService } from './operations-bookings.service'
import { BookingOpsDatabase } from '../booking-ops/booking-ops-database'
import { BookingAccessGuard } from '../booking-ops/booking-access.guard'
import { BookingActionsController } from '../booking-ops/booking-actions.controller'
import { BookingActionsService } from '../booking-ops/booking-actions.service'
import { BookingFinanceController } from '../booking-ops/booking-finance.controller'
import { BookingSavedViewsController } from '../booking-ops/booking-saved-views.controller'
import { BookingSavedViewsService } from '../booking-ops/booking-saved-views.service'
import { BookingQueryService } from '../booking-ops/booking-query.service'
import { BookingFinanceService } from '../booking-ops/booking-finance.service'
import { BookingPenaltyQuoter } from '../booking-ops/booking-penalty-quote'
import { BookingOpsController } from '../booking-ops/booking-ops.controller'
import { BookingOpsQueueService } from '../booking-ops/booking-ops-queue.service'
import { BookingOpsService } from '../booking-ops/booking-ops.service'
import { BookingSupplierJobsService } from '../booking-ops/booking-supplier-jobs.service'
import { BookingSupplierRunner } from '../booking-ops/booking-supplier-runner.service'
import { BOOKING_SUPPLIER_RESOLVER } from '../booking-ops/supplier/booking-supplier.port'
import { BookingSupplierRegistry } from '../booking-ops/supplier/booking-supplier.registry'

@Module({
  imports: [AuthModule, AgentModule, ApprovalsModule],
  controllers: [OperationsController, BookingActionsController, BookingOpsController, BookingFinanceController, BookingSavedViewsController],
  providers: [BookingOpsQueueService, BookingOpsService, { provide: BOOKING_SUPPLIER_RESOLVER, useExisting: BookingSupplierRegistry }, BookingSupplierRegistry, BookingSupplierJobsService, BookingSupplierRunner, BookingActionsService, BookingFinanceService, BookingPenaltyQuoter, BookingQueryService, BookingSavedViewsService, BookingOpsDatabase, BookingAccessGuard, OperationsBookingsService, OperationsSupplyService, OperationsTransactionsService, OperationsHotelsService, OperationsFinanceAuditService, OperationsReconciliationApprovalsService, OperationsGovernanceService],
})
export class AdminOperationsModule {}
