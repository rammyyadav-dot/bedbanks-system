import { AuthModule } from '../auth/auth.module'
import { Module } from '@nestjs/common'
import { AgentController } from './agent.controller'
import { AgentAuditService } from './audit.service'
import { LedgerService } from './ledger.service'
import { AgentFinanceService } from './finance.service'
import { AgentRbacGuard } from './rbac.guard'
import { TenantContextGuard } from './tenant-context.guard'
import { SUPPLIER_ADAPTER, UnconfiguredSupplierAdapter } from './supplier.port'
import { InventoryHoldService } from './inventory-hold.service'
import { OfferHoldService } from './offer-hold.service'
import { AgentSearchService } from './agent-search.service'
import { CACHE_PORT, NoopCache } from '../common/cache/cache.port'

@Module({
  imports: [AuthModule],
  controllers: [AgentController],
  providers: [
    AgentRbacGuard,
    TenantContextGuard,
    AgentAuditService,
    LedgerService,
    AgentFinanceService,
    InventoryHoldService,
    OfferHoldService,
    AgentSearchService,
    { provide: CACHE_PORT, useClass: NoopCache },
    { provide: SUPPLIER_ADAPTER, useClass: UnconfiguredSupplierAdapter },
  ],
  exports: [AgentRbacGuard, TenantContextGuard, SUPPLIER_ADAPTER],
})
export class AgentModule {}
