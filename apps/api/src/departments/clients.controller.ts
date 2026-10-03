import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type { AgencyCreate, AgencySuspensionDecision, AgencySuspensionRequest, AgencyUpdate } from '@bedbanks/contracts'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ClientsService } from './clients.service'
import { AgencySuspensionService } from './agency-suspension.service'
import { AgencyCreditService } from './agency-credit.service'

type Q = Record<string, unknown>

/** Agencies and their members (ADR 0019). Tenant from the session; reads need agency.read, changes agency.manage. */
@ApiTags('admin-clients')
@Controller('admin/clients')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class ClientsController {
  constructor(private readonly clients: ClientsService, private readonly suspension: AgencySuspensionService, private readonly credit: AgencyCreditService) {}

  @Get('summary') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  summary(@ActiveTenant() tenantId: string) { return this.clients.summary(tenantId) }

  @Get('agencies') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: Q) { return this.suspension.list(tenantId, identity.user.id, query) }

  @Post('agencies') @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: AgencyCreate) { return this.clients.create(tenantId, identity.user.id, body ?? ({} as AgencyCreate)) }

  @Get('member-candidates') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  candidates(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.clients.candidates(tenantId, query) }

  @Get('agencies/:agencyId') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  get(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string) { return this.credit.detail(tenantId, identity.user.id, agencyId) }

  @Patch('agencies/:agencyId') @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  update(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Body() body: AgencyUpdate) { return this.clients.update(tenantId, identity.user.id, agencyId, body ?? {}) }

  @Get('agencies/:agencyId/members') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  members(@ActiveTenant() tenantId: string, @Param('agencyId') agencyId: string) { return this.clients.members(tenantId, agencyId) }

  @Post('agencies/:agencyId/members') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  addMember(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Body() body: { userId?: string }) { return this.clients.addMember(tenantId, identity.user.id, agencyId, body?.userId) }

  @Delete('agencies/:agencyId/members/:userId') @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  removeMember(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Param('userId') userId: string) { return this.clients.removeMember(tenantId, identity.user.id, agencyId, userId) }

  // Suspend or reinstate (ADR 0020): maker-checker. Every step needs agency.manage; the approval service enforces a different approver and single use.
  @Post('agencies/:agencyId/request-suspension-change') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  requestSuspension(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Body() body: AgencySuspensionRequest) { return this.suspension.request(tenantId, identity.user.id, agencyId, body ?? ({} as AgencySuspensionRequest)) }

  @Post('agencies/suspension-approvals/:approvalId/approve') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  approveSuspension(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: AgencySuspensionDecision) { return this.suspension.decide(tenantId, identity.user.id, approvalId, 'APPROVED', body) }

  @Post('agencies/suspension-approvals/:approvalId/reject') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  rejectSuspension(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: AgencySuspensionDecision) { return this.suspension.decide(tenantId, identity.user.id, approvalId, 'REJECTED', body) }

  @Post('agencies/suspension-approvals/:approvalId/cancel') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  withdrawSuspensionRequest(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.suspension.cancel(tenantId, identity.user.id, approvalId) }

  @Post('agencies/suspension-approvals/:approvalId/execute') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  executeSuspension(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.suspension.execute(tenantId, identity.user.id, approvalId) }

}
