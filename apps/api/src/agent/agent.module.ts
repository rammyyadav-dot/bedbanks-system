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
import { BookingPersistenceService } from './booking-persistence.service'
import { BookingFinancialAuthorizationService } from './booking-financial-authorization.service'
import { SupplierPrebookOrchestrationService } from './supplier-prebook-orchestration.service'
import { PrebookCompensationRecoveryService } from './prebook-compensation-recovery.service'
import { CACHE_PORT, COORDINATION_PORT, NoopCache, NoopCoordination } from '../common/cache/cache.port'
import { redisFromEnvironment } from '../common/cache/redis-cache.adapter'

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
    BookingPersistenceService,
    BookingFinancialAuthorizationService,
    SupplierPrebookOrchestrationService,
    PrebookCompensationRecoveryService,
    {
      provide: CACHE_PORT,
      useFactory: () => redisFromEnvironment() ?? new NoopCache(),
    },
    {
      provide: COORDINATION_PORT,
      useFactory: () => redisFromEnvironment() ?? new NoopCoordination(),
    },
    { provide: SUPPLIER_ADAPTER, useClass: UnconfiguredSupplierAdapter },
  ],
  exports: [AgentRbacGuard, TenantContextGuard, SUPPLIER_ADAPTER],
})
export class AgentModule {}
