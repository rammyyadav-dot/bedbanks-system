import { AuthModule } from '../auth/auth.module'
import { Module } from '@nestjs/common'
import { AgentController } from './agent.controller'
import { AgentAuditService } from './audit.service'
import { LedgerService } from './ledger.service'
import { AgentFinanceService } from './finance.service'
import { AgentRbacGuard } from './rbac.guard'
import { AgencySuspensionGuard } from './agency-suspension.guard'
import { TenantContextGuard } from './tenant-context.guard'
import { ContractedInventoryAdapter } from './contracted-inventory.adapter'
import { SUPPLIER_ADAPTER } from './supplier.port'
import { InventoryHoldService } from './inventory-hold.service'
import { OfferHoldService } from './offer-hold.service'
import { HoldExpirySweeper } from './hold-expiry-sweeper.service'
import { AgentSearchService } from './agent-search.service'
import { DestinationResolverService } from './destination-resolver.service'
import { BookingPersistenceService } from './booking-persistence.service'
import { BookingFinancialAuthorizationService } from './booking-financial-authorization.service'
import { SupplierPrebookOrchestrationService } from './supplier-prebook-orchestration.service'
import { PrebookCompensationRecoveryService } from './prebook-compensation-recovery.service'
import { BookingReconciliationService } from './booking-reconciliation.service'
import { BookingConfirmationService } from './booking-confirmation.service'
import { BookingTransactionService } from './booking-transaction.service'
import { CancellationPolicyService } from './cancellation-policy.service'
import { BookingCancellationService } from './booking-cancellation.service'
import { BookingDocumentService } from './booking-document.service'
import { BookingQueryService } from './booking-query.service'
import { SupplierMutationJournalService } from './supplier-mutation-journal.service'
import { CACHE_PORT, COORDINATION_PORT, NoopCache, NoopCoordination } from '../common/cache/cache.port'
import { redisFromEnvironment } from '../common/cache/redis-cache.adapter'

@Module({
  imports: [AuthModule],
  controllers: [AgentController],
  providers: [
    AgentRbacGuard,
    AgencySuspensionGuard,
    TenantContextGuard,
    AgentAuditService,
    LedgerService,
    AgentFinanceService,
    InventoryHoldService,
    { provide: HoldExpirySweeper, useFactory: () => new HoldExpirySweeper() },
    OfferHoldService,
    AgentSearchService,
    DestinationResolverService,
    BookingPersistenceService,
    BookingFinancialAuthorizationService,
    SupplierPrebookOrchestrationService,
    PrebookCompensationRecoveryService,
    BookingReconciliationService,
    BookingConfirmationService,
    BookingTransactionService,
    CancellationPolicyService,
    BookingCancellationService,
    BookingDocumentService,
    BookingQueryService,
    SupplierMutationJournalService,
    {
      provide: CACHE_PORT,
      useFactory: () => redisFromEnvironment() ?? new NoopCache(),
    },
    {
      provide: COORDINATION_PORT,
      useFactory: () => redisFromEnvironment() ?? new NoopCoordination(),
    },
    { provide: SUPPLIER_ADAPTER, useClass: ContractedInventoryAdapter },
  ],
  exports: [AgentRbacGuard, TenantContextGuard, SUPPLIER_ADAPTER, BookingReconciliationService],
})
export class AgentModule {}
