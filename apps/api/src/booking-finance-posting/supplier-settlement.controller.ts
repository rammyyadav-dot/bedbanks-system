import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { SettlementDecisionRequest, SettlementProposeRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { SupplierSettlementService } from './supplier-settlement.service'

const requestIdOf = (req: Request) => String((req as Request & { id?: string }).id ?? req.headers['x-request-id'] ?? 'unknown').slice(0, 80)

/**
 * Supplier settlements (ADR 0077). Reads need finance.read. Proposing needs finance.settle.propose and approving or rejecting needs finance.settle.approve, both from a formal
 * role; the service refuses an approval by the proposer. Tenant identity comes from the session only. Records payments made outside the system; moves no money.
 */
@ApiTags('admin-supplier-settlements')
@Controller('admin/finance/supplier-settlements')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class SupplierSettlementController {
  constructor(private readonly settlements: SupplierSettlementService) {}

  @Get() @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  list(@ActiveTenant() tenantId: string, @Query() query: Record<string, unknown>) { return this.settlements.list(tenantId, query) }

  @Post() @HttpCode(200) @RequireDepartmentPermission('finance.settle.propose') @UseGuards(SupplyPermissionGuard)
  propose(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: SettlementProposeRequest, @Req() req: Request) { return this.settlements.propose(tenantId, identity.user.id, body, requestIdOf(req)) }

  @Post(':settlementId/approve') @HttpCode(200) @RequireDepartmentPermission('finance.settle.approve') @UseGuards(SupplyPermissionGuard)
  approve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('settlementId') settlementId: string, @Req() req: Request) { return this.settlements.approve(tenantId, identity.user.id, settlementId, requestIdOf(req)) }

  @Post(':settlementId/reject') @HttpCode(200) @RequireDepartmentPermission('finance.settle.approve') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('settlementId') settlementId: string, @Body() body: SettlementDecisionRequest, @Req() req: Request) { return this.settlements.reject(tenantId, identity.user.id, settlementId, body, requestIdOf(req)) }
}
