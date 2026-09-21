import { Module } from '@nestjs/common'
import { SupplyController } from './supply.controller'
import { SupplyService } from './supply.service'
import { AgentAuditService } from '../agent/audit.service'

@Module({ controllers: [SupplyController], providers: [SupplyService, AgentAuditService] })
export class SupplyModule {}
