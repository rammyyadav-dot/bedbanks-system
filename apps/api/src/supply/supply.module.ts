import { Module } from '@nestjs/common'
import { SupplyController } from './supply.controller'
import { SupplyService } from './supply.service'
import { AgentAuditService } from '../agent/audit.service'
import { AuthModule } from '../auth/auth.module'
import { MappingController } from './mapping.controller'
import { MappingService } from './mapping.service'
import { RatePlanOpsDatabase } from './rate-plan-ops-database'

@Module({ imports: [AuthModule], controllers: [SupplyController, MappingController], providers: [SupplyService, MappingService, AgentAuditService, RatePlanOpsDatabase] })
export class SupplyModule {}
