import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import type { AgencyCreate, AgencyUpdate } from '@bedbanks/contracts'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireDepartmentPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ClientsService } from './clients.service'

type Q = Record<string, unknown>

/** Agencies and their members (ADR 0019). Tenant from the session; reads need agency.read, changes agency.manage. */
@ApiTags('admin-clients')
@Controller('admin/clients')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get('summary') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  summary(@ActiveTenant() tenantId: string) { return this.clients.summary(tenantId) }

  @Get('agencies') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.clients.list(tenantId, query) }

  @Post('agencies') @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: AgencyCreate) { return this.clients.create(tenantId, identity.user.id, body ?? ({} as AgencyCreate)) }

  @Get('member-candidates') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  candidates(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.clients.candidates(tenantId, query) }

  @Get('agencies/:agencyId') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  get(@ActiveTenant() tenantId: string, @Param('agencyId') agencyId: string) { return this.clients.get(tenantId, agencyId) }

  @Patch('agencies/:agencyId') @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  update(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Body() body: AgencyUpdate) { return this.clients.update(tenantId, identity.user.id, agencyId, body ?? {}) }

  @Get('agencies/:agencyId/members') @RequireDepartmentPermission('agency.read') @UseGuards(SupplyPermissionGuard)
  members(@ActiveTenant() tenantId: string, @Param('agencyId') agencyId: string) { return this.clients.members(tenantId, agencyId) }

  @Post('agencies/:agencyId/members') @HttpCode(200) @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  addMember(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Body() body: { userId?: string }) { return this.clients.addMember(tenantId, identity.user.id, agencyId, body?.userId) }

  @Delete('agencies/:agencyId/members/:userId') @RequireDepartmentPermission('agency.manage') @UseGuards(SupplyPermissionGuard)
  removeMember(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('agencyId') agencyId: string, @Param('userId') userId: string) { return this.clients.removeMember(tenantId, identity.user.id, agencyId, userId) }
}

