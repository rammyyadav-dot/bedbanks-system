import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { AdminDashboardController } from './admin-dashboard.controller'
import { AdminDashboardService } from './admin-dashboard.service'
import { AdminRbacGuard } from '../auth/admin-rbac.guard'

@Module({
  imports: [AuthModule],
  controllers: [AdminDashboardController],
  providers: [AdminDashboardService, AdminRbacGuard],
})
export class AdminDashboardModule {}
