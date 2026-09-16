import { AuthModule } from '../auth/auth.module'
import { Module } from '@nestjs/common'
import { AgentController } from './agent.controller'
import { AgentAuditService } from './audit.service'
import { AgentFinanceService } from './finance.service'
import { AgentRbacGuard } from './rbac.guard'
import { TenantContextGuard } from './tenant-context.guard'
import { SUPPLIER_ADAPTER, UnconfiguredSupplierAdapter } from './supplier.port'

@Module({
  imports: [AuthModule],
  controllers: [AgentController],
  providers: [
    AgentRbacGuard,
    TenantContextGuard,
    AgentAuditService,
    AgentFinanceService,
    { provide: SUPPLIER_ADAPTER, useClass: UnconfiguredSupplierAdapter },
  ],
  exports: [AgentRbacGuard, TenantContextGuard, SUPPLIER_ADAPTER],
})
export class AgentModule {}
