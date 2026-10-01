import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { CrossSiteRequestGuard } from './common/guards/cross-site-request.guard';
import configuration from './config/configuration';
import { validate } from './config/env.validation';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AgentModule } from './agent/agent.module';
import { AdminDashboardModule } from './admin-dashboard/admin-dashboard.module';
import { AdminSettingsModule } from './admin-settings/admin-settings.module';
import { PlatformAdminModule } from './platform-admin/platform-admin.module';
import { SupplyModule } from './supply/supply.module';
import { SupplierExtranetModule } from './supplier-extranet/supplier-extranet.module';

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
    AdminSettingsModule,
    PlatformAdminModule,
    SupplyModule,
    SupplierExtranetModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: CrossSiteRequestGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
