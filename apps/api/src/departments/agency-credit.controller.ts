import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import type { AgencyCreditDecision, AgencyCreditLimitRequest } from '@bedbanks/contracts'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { AgencyCreditService } from './agency-credit.service'

/**
 * Agency credit limit changes (ADR 0024), kept apart from ClientsController on purpose: the Clients department has no money
 * authority (ADR 0019). A credit limit is an exposure ceiling, not a wallet or ledger, and every change is a maker-checker request.
 */
@ApiTags('admin-clients')
@Controller('admin/clients')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class AgencyCreditController {
  constructor(private readonly credit: AgencyCreditService) {}

  @Post('agencies/:agencyId/request-credit-limit') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  requestCredit(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Body() body: AgencyCreditLimitRequest) { return this.credit.request(tenantId, identity.user.id, agencyId, body ?? ({} as AgencyCreditLimitRequest)) }

  @Post('agencies/credit-approvals/:approvalId/approve') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  approveCredit(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: AgencyCreditDecision) { return this.credit.decide(tenantId, identity.user.id, approvalId, 'APPROVED', body) }

  @Post('agencies/credit-approvals/:approvalId/reject') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  rejectCredit(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: AgencyCreditDecision) { return this.credit.decide(tenantId, identity.user.id, approvalId, 'REJECTED', body) }

  @Post('agencies/credit-approvals/:approvalId/cancel') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  withdrawCredit(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.credit.cancel(tenantId, identity.user.id, approvalId) }

  @Post('agencies/credit-approvals/:approvalId/execute') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  executeCredit(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.credit.execute(tenantId, identity.user.id, approvalId) }
}
