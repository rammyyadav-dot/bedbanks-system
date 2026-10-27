import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { FinancePeriodService } from './finance-period.service'

/** Finance period close (ADR 0101). Reads need finance.read; closing needs finance.period.close from a formal role. Tenant identity comes from the session only. */
@ApiTags('admin-finance-periods')
@Controller('admin/finance/periods')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class FinancePeriodController {
  constructor(private readonly periods: FinancePeriodService) {}

  @Get() @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  list(@ActiveTenant() tenantId: string, @Query() query: Record<string, unknown>) { return this.periods.list(tenantId, query) }

  @Get('preview') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  preview(@ActiveTenant() tenantId: string, @Query() query: Record<string, unknown>) { return this.periods.preview(tenantId, query) }

  @Post('close') @HttpCode(200) @RequireDepartmentPermission('finance.period.close') @UseGuards(SupplyPermissionGuard)
  close(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.periods.close(tenantId, identity.user.id, body) }
}
