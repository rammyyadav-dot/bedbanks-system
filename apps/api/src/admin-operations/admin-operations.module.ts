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

@Module({
  imports: [AuthModule, AgentModule, ApprovalsModule],
  controllers: [OperationsController, BookingActionsController],
  providers: [BookingActionsService, BookingOpsDatabase, BookingAccessGuard, OperationsBookingsService, OperationsSupplyService, OperationsTransactionsService, OperationsHotelsService, OperationsFinanceAuditService, OperationsReconciliationApprovalsService, OperationsGovernanceService],
})
export class AdminOperationsModule {}
