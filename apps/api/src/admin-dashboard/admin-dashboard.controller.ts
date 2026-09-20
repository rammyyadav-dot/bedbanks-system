import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { AdminRbacGuard, RequireAdminPermission } from '../auth/admin-rbac.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AdminDashboardService, type DashboardRange } from './admin-dashboard.service'

@Controller('admin/dashboard')
@UseGuards(SessionAuthGuard, AdminRbacGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @RequireAdminPermission('dashboard.read')
  getDashboard(@CurrentUser() identity: AuthenticatedUser, @Query('range') range = '7d') {
    if (!['7d', '30d', '90d'].includes(range)) throw new BadRequestException('range must be 7d, 30d, or 90d')
    return this.dashboard.getDashboard(identity, range as DashboardRange)
  }
}
