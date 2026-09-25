import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { AdminRbacGuard, RequireAdminPermission } from '../auth/admin-rbac.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AdminDashboardService } from './admin-dashboard.service'
import { DashboardQueryDto } from './dto/dashboard-query.dto'

@Controller('admin/dashboard')
@UseGuards(SessionAuthGuard, AdminRbacGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @RequireAdminPermission('dashboard.read')
  getDashboard(@CurrentUser() identity: AuthenticatedUser, @Query() query: DashboardQueryDto) {
    return this.dashboard.getDashboard(identity, query.range)
  }
}
