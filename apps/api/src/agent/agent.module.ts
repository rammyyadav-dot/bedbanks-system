import { Module } from '@nestjs/common'
import { AgentController } from './agent.controller'
import { AgentRbacGuard } from './rbac.guard'
import { TenantContextGuard } from './tenant-context.guard'
import { SUPPLIER_ADAPTER, UnconfiguredSupplierAdapter } from './supplier.port'

@Module({
  controllers: [AgentController],
  providers: [
    AgentRbacGuard,
    TenantContextGuard,
    { provide: SUPPLIER_ADAPTER, useClass: UnconfiguredSupplierAdapter },
  ],
  exports: [AgentRbacGuard, TenantContextGuard, SUPPLIER_ADAPTER],
})
export class AgentModule {}
