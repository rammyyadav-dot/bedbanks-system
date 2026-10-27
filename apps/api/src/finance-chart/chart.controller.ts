import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ChartService } from './chart.service'

/** General-ledger chart of accounts and journal (ADR 0102). Reads need finance.read; writes need finance.chart.manage from a formal role. Tenant identity comes from the session only. */
@ApiTags('admin-finance-chart')
@Controller('admin/finance')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class ChartController {
  constructor(private readonly chart: ChartService) {}

  @Get('chart') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  get(@ActiveTenant() tenantId: string) { return this.chart.get(tenantId) }

  @Get('journal') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  journal(@ActiveTenant() tenantId: string, @Query() query: Record<string, unknown>) { return this.chart.journal(tenantId, query) }

  @Post('chart/initialize') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  initialize(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser) { return this.chart.initialize(tenantId, identity.user.id) }

  @Post('chart/accounts') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  createAccount(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.chart.createAccount(tenantId, identity.user.id, body) }

  @Post('chart/accounts/:accountId/deactivate') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  deactivate(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('accountId') accountId: string) { return this.chart.deactivate(tenantId, identity.user.id, accountId) }

  @Post('chart/mappings') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  setMapping(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.chart.setMapping(tenantId, identity.user.id, body) }
}
