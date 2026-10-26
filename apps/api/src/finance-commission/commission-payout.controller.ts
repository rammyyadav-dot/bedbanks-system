import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { CommissionPayoutService } from './commission-payout.service'

/**
 * Dynamic, tier-based commission payouts to agencies (ADR 0098). Reads need finance.read. Proposing needs finance.commission.propose and approving or rejecting needs
 * finance.commission.approve, both from a formal role; the service refuses a decision by the proposer. Tenant identity comes from the session only.
 */
@ApiTags('admin-commission-payouts')
@Controller('admin/finance/commission-payouts')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class CommissionPayoutController {
  constructor(private readonly payouts: CommissionPayoutService) {}

  @Get() @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Record<string, unknown>) { return this.payouts.list(tenantId, identity.user.id, query) }

  @Post() @HttpCode(200) @RequireDepartmentPermission('finance.commission.propose') @UseGuards(SupplyPermissionGuard)
  propose(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.payouts.propose(tenantId, identity.user.id, body) }

  @Post(':payoutId/approve') @HttpCode(200) @RequireDepartmentPermission('finance.commission.approve') @UseGuards(SupplyPermissionGuard)
  approve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('payoutId') payoutId: string) { return this.payouts.approve(tenantId, identity.user.id, payoutId) }

  @Post(':payoutId/reject') @HttpCode(200) @RequireDepartmentPermission('finance.commission.approve') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('payoutId') payoutId: string, @Body() body: unknown) { return this.payouts.reject(tenantId, identity.user.id, payoutId, body) }
}
