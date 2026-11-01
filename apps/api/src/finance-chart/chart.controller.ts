import { randomUUID } from 'node:crypto'
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'
import { GL_JOURNAL_EXPORT_HEADERS } from '@bedbanks/contracts'
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

  /** A CSV download of a closed month's journal, audited with the hash of the file. Errors keep the normal JSON envelope. Declared before any `journal/:x` route. */
  @Get('journal/export') @RequireDepartmentPermission('finance.journal.export') @UseGuards(SupplyPermissionGuard)
  async exportJournal(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    const requestId = (req as Request & { requestId?: string }).requestId ?? randomUUID()
    const file = await this.chart.exportJournal(tenantId, identity.user.id, requestId, query)
    res.status(200).set({
      'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file.name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      [GL_JOURNAL_EXPORT_HEADERS.sha256]: file.sha256, [GL_JOURNAL_EXPORT_HEADERS.rows]: String(file.rows), [GL_JOURNAL_EXPORT_HEADERS.suspenseEntries]: String(file.suspenseEntries),
    }).send(file.csv)
  }

  @Post('chart/initialize') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  initialize(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser) { return this.chart.initialize(tenantId, identity.user.id) }

  @Post('chart/accounts') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  createAccount(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.chart.createAccount(tenantId, identity.user.id, body) }

  @Post('chart/accounts/:accountId/deactivate') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  deactivate(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('accountId') accountId: string) { return this.chart.deactivate(tenantId, identity.user.id, accountId) }

  @Post('chart/mappings') @HttpCode(200) @RequireDepartmentPermission('finance.chart.manage') @UseGuards(SupplyPermissionGuard)
  setMapping(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.chart.setMapping(tenantId, identity.user.id, body) }
}
