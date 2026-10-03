import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { ApprovalsModule } from '../approvals/approvals.module'
import { AgentAuditService } from '../agent/audit.service'
import { ClientsController } from './clients.controller'
import { ServiceCasesController } from './service-cases.controller'
import { DistributionController } from './distribution.controller'
import { ClientsService } from './clients.service'
import { AgencySuspensionService } from './agency-suspension.service'
import { ServiceCasesService } from './service-cases.service'
import { DistributionService } from './distribution.service'

/** Clients, Service and Distribution (ADR 0019). */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [ClientsController, ServiceCasesController, DistributionController],
  providers: [ClientsService, AgencySuspensionService, ServiceCasesService, DistributionService, AgentAuditService],
})
export class DepartmentsModule {}
