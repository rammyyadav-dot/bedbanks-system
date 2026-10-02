import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { MarkupActivationRequest, MarkupDecision, MarkupRuleCreate } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { CommercialMarkupService } from './commercial-markup.service'

type Q = Record<string, unknown>

/**
 * NET-rate markup rules (ADR 0018). Tenant identity comes from the session. Reads need supply.rates.read; every change needs
 * supply.rates.manage, and activation additionally needs a different person's approval, enforced by the approval service.
 */
@ApiTags('admin-commercial')
@Controller('admin/commercial/markups')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class CommercialController {
  constructor(private readonly markups: CommercialMarkupService) {}

  @Get() @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.markups.list(tenantId, identity.user.id, query) }

  @Post() @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: MarkupRuleCreate) { return this.markups.create(tenantId, identity.user.id, body ?? ({} as MarkupRuleCreate)) }

  @Post(':ruleId/retire') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  retire(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('ruleId') ruleId: string) { return this.markups.retire(tenantId, identity.user.id, ruleId) }

  @Post(':ruleId/request-activation') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  requestActivation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('ruleId') ruleId: string, @Body() body: MarkupActivationRequest) { return this.markups.requestActivation(tenantId, identity.user.id, ruleId, body ?? ({} as MarkupActivationRequest)) }

  @Post('approvals/:approvalId/approve') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  approve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: MarkupDecision) { return this.markups.decide(tenantId, identity.user.id, approvalId, 'APPROVED', body) }

  @Post('approvals/:approvalId/reject') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: MarkupDecision) { return this.markups.decide(tenantId, identity.user.id, approvalId, 'REJECTED', body) }

  @Post('approvals/:approvalId/cancel') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  cancel(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.markups.cancel(tenantId, identity.user.id, approvalId) }

  @Post('approvals/:approvalId/execute') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  execute(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.markups.execute(tenantId, identity.user.id, approvalId) }
}
