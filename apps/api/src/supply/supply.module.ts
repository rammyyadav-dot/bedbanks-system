import { Module } from '@nestjs/common'
import { SupplyController } from './supply.controller'
import { SupplyService } from './supply.service'
import { AgentAuditService } from '../agent/audit.service'
import { CancellationPolicyService } from '../agent/cancellation-policy.service'
import { LedgerService } from '../agent/ledger.service'
import { CancellationNotificationService } from './cancellation-notification.service'
import { AuthModule } from '../auth/auth.module'
import { MappingController } from './mapping.controller'
import { MappingService } from './mapping.service'

@Module({
  imports: [AuthModule],
  controllers: [SupplyController, MappingController],
  providers: [SupplyService, MappingService, AgentAuditService, CancellationPolicyService, LedgerService, CancellationNotificationService],
})
export class SupplyModule {}
