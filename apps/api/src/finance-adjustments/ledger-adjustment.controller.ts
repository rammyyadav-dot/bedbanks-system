import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { LedgerAdjustmentService } from './ledger-adjustment.service'

/**
 * Ledger adjustments and reversals (ADR 0100). Reads need finance.read. Proposing needs finance.adjustment.propose and approving or rejecting needs finance.adjustment.approve, both from a
 * formal role; the service refuses a decision by the proposer. Tenant identity comes from the session only.
 */
@ApiTags('admin-ledger-adjustments')
@Controller('admin/finance/ledger-adjustments')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class LedgerAdjustmentController {
  constructor(private readonly adjustments: LedgerAdjustmentService) {}

  @Get() @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Record<string, unknown>) { return this.adjustments.list(tenantId, identity.user.id, query) }

  @Post() @HttpCode(200) @RequireDepartmentPermission('finance.adjustment.propose') @UseGuards(SupplyPermissionGuard)
  propose(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.adjustments.propose(tenantId, identity.user.id, body) }

  @Post(':adjustmentId/approve') @HttpCode(200) @RequireDepartmentPermission('finance.adjustment.approve') @UseGuards(SupplyPermissionGuard)
  approve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('adjustmentId') adjustmentId: string) { return this.adjustments.approve(tenantId, identity.user.id, adjustmentId) }

  @Post(':adjustmentId/reject') @HttpCode(200) @RequireDepartmentPermission('finance.adjustment.approve') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('adjustmentId') adjustmentId: string, @Body() body: unknown) { return this.adjustments.reject(tenantId, identity.user.id, adjustmentId, body) }
}
