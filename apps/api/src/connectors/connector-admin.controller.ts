import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ConnectorAdminService } from './connector-admin.service'

/**
 * Connector administration (audit findings F4 and F9, ADR 0085). Tenant identity comes from the session. Reads need supply.connectors.read; every change and every approval step needs
 * supply.connectors.manage, and activation additionally needs a different person's approval, enforced by the approval service. No route accepts an endpoint or secret material.
 */
@ApiTags('supply-connectors')
@Controller('supply/connectors')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class ConnectorAdminController {
  constructor(private readonly connectors: ConnectorAdminService) {}

  @Get() @RequireSupplyPermission('supply.connectors.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Query('supplierId') supplierId?: string) { return this.connectors.list(tenantId, identity.user.id, { supplierId }) }

  @Get(':connectorId') @RequireSupplyPermission('supply.connectors.read') @UseGuards(SupplyPermissionGuard)
  get(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('connectorId') connectorId: string) { return this.connectors.get(tenantId, identity.user.id, connectorId) }

  @Post() @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Body() body: unknown) { return this.connectors.create(tenantId, identity.user.id, body) }

  @Post(':connectorId/credential-references') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  setCredential(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('connectorId') connectorId: string, @Body() body: unknown) { return this.connectors.setCredentialReference(tenantId, identity.user.id, connectorId, body) }

  @Post(':connectorId/request-activation') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  requestActivation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('connectorId') connectorId: string, @Body() body: unknown) { return this.connectors.requestActivation(tenantId, identity.user.id, connectorId, body) }

  @Post(':connectorId/suspend') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  suspend(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('connectorId') connectorId: string, @Body() body: unknown) { return this.connectors.suspend(tenantId, identity.user.id, connectorId, body) }

  @Post(':connectorId/disable') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  disable(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('connectorId') connectorId: string, @Body() body: unknown) { return this.connectors.disable(tenantId, identity.user.id, connectorId, body) }

  @Post('approvals/:approvalId/approve') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  approve(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: unknown) { return this.connectors.decide(tenantId, identity.user.id, approvalId, 'APPROVED', body) }

  @Post('approvals/:approvalId/reject') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  reject(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string, @Body() body: unknown) { return this.connectors.decide(tenantId, identity.user.id, approvalId, 'REJECTED', body) }

  @Post('approvals/:approvalId/cancel') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  cancel(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.connectors.cancel(tenantId, identity.user.id, approvalId) }

  @Post('approvals/:approvalId/execute') @HttpCode(200) @RequireSupplyPermission('supply.connectors.manage') @UseGuards(SupplyPermissionGuard)
  execute(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('approvalId') approvalId: string) { return this.connectors.execute(tenantId, identity.user.id, approvalId) }
}
