import { Module } from '@nestjs/common'
import { SupplyController } from './supply.controller'
import { SupplyService } from './supply.service'
import { AgentAuditService } from '../agent/audit.service'
import { AuthModule } from '../auth/auth.module'
import { MappingController } from './mapping.controller'
import { MappingService } from './mapping.service'
import { RatePlanMappingService } from './rate-plan-mapping.service'
import { RatePlanOpsDatabase } from './rate-plan-ops-database'
import { ApprovalsModule } from '../approvals/approvals.module'
import { RatePlanApprovalController } from './rate-plan-approval.controller'
import { RatePlanApprovalService } from './rate-plan-approval.service'
import { RatePlanCloneDatabase } from './rate-plan-clone-database'
import { RatePlanExpirySweeper } from './rate-plan-expiry-sweeper.service'
import { ContractApprovalController } from './contract-approval.controller'
import { ContractApprovalService } from './contract-approval.service'

@Module({ imports: [AuthModule, ApprovalsModule], controllers: [SupplyController, MappingController, RatePlanApprovalController, ContractApprovalController], providers: [SupplyService, MappingService, RatePlanMappingService, AgentAuditService, RatePlanOpsDatabase, RatePlanCloneDatabase, RatePlanApprovalService, RatePlanExpirySweeper, ContractApprovalService] })
export class SupplyModule {}
