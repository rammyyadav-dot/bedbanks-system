import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AgentAuditService } from './agent/audit.service';
import { DatabaseDenialInterceptor } from './database/database-denial.interceptor';
import { CrossSiteRequestGuard } from './common/guards/cross-site-request.guard';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AgentModule } from './agent/agent.module';
import { AdminDashboardModule } from './admin-dashboard/admin-dashboard.module';
import { AdminOperationsModule } from './admin-operations/admin-operations.module';
import { RateCertificationModule } from './rate-certification/rate-certification.module';
import { CommercialModule } from './commercial/commercial.module';
import { PromotionsModule } from './promotions/promotions.module';
import { DepartmentsModule } from './departments/departments.module';
import { FundingModule } from './funding/funding.module';
import { FinanceReconciliationModule } from './finance-reconciliation/finance-reconciliation.module';
import { FinanceCreditNotesModule } from './finance-credit-notes/finance-credit-notes.module';
import { FinanceCommissionModule } from './finance-commission/finance-commission.module';
import { FinanceAdjustmentsModule } from './finance-adjustments/finance-adjustments.module';
import { FinancePeriodsModule } from './finance-periods/finance-periods.module';
import { BookingFinancePostingModule } from './booking-finance-posting/booking-finance-posting.module';
import { SupplierIngestModule } from './supplier-ingest/supplier-ingest.module';
import { SupplierPromotionModule } from './supplier-promotion/supplier-promotion.module';
import { HotelSetupModule } from './hotel-setup/hotel-setup.module';
import { AdminSettingsModule } from './admin-settings/admin-settings.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { SupplyModule } from './supply/supply.module';
import { SupplierExtranetModule } from './supplier-extranet/supplier-extranet.module';
import { DistributionModule } from './distribution/distribution.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
      envFilePath: ['.env', '.env.local'],
    }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    AgentModule,
    AdminDashboardModule,
    AdminOperationsModule,
    RateCertificationModule,
    CommercialModule,
    PromotionsModule,
    DepartmentsModule,
    FundingModule,
    FinanceReconciliationModule,
    FinanceCreditNotesModule,
    FinanceCommissionModule,
    FinanceAdjustmentsModule,
    FinancePeriodsModule,
    BookingFinancePostingModule,
    SupplierIngestModule,
    SupplierPromotionModule,
    HotelSetupModule,
    AdminSettingsModule,
    PlatformAdminModule,
    SupplyModule,
    SupplierExtranetModule,
    DistributionModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: CrossSiteRequestGuard }, AgentAuditService, { provide: APP_INTERCEPTOR, useClass: DatabaseDenialInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
