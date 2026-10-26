import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApprovalsModule } from '../approvals/approvals.module'
import { AgentAuditService } from '../agent/audit.service'
import { AgentFundingController, FundingController } from './funding.controller'
import { FundingService } from './funding.service'

/** Agency funding receipts (ADR 0028 slice 2). */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [FundingController, AgentFundingController],
  providers: [FundingService, AgentAuditService],
})
export class FundingModule {}
