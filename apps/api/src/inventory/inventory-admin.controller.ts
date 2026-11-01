import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { InventoryPoolCreateRequest, InventoryPoolMembersRequest, InventoryPoolUpdateRequest, InventoryReleaseRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { InventoryAdminService } from './inventory-admin.service'

const requestIdOf = (req: Request) => (req as unknown as { requestId?: string }).requestId ?? null

/**
 * Inventory & Allotment (ADR 0030). Tenant identity comes from the session. Reads need supply.availability.read; every change
 * needs supply.availability.manage. Existing permissions are reused: no new permission names.
 */
@ApiTags('admin-hotel-inventory')
@Controller('admin/hotels/:hotelId/inventory')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class InventoryAdminController {
  constructor(private readonly inventory: InventoryAdminService) {}

  @Get('summary') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  summary(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: { from?: unknown; days?: unknown }) { return this.inventory.summary(tenantId, hotelId, query) }

  @Post('pools') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  createPool(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: InventoryPoolCreateRequest, @Req() req: Request) { return this.inventory.createPool(tenantId, identity.user.id, hotelId, body, requestIdOf(req)) }

  @Patch('pools/:poolId') @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  updatePool(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: InventoryPoolUpdateRequest, @Req() req: Request) { return this.inventory.updatePool(tenantId, identity.user.id, hotelId, poolId, body, requestIdOf(req)) }

  @Post('pools/:poolId/members/add') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  addMembers(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: InventoryPoolMembersRequest, @Req() req: Request) { return this.inventory.addMembers(tenantId, identity.user.id, hotelId, poolId, body, requestIdOf(req)) }

  @Post('pools/:poolId/members/remove') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  removeMembers(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: InventoryPoolMembersRequest, @Req() req: Request) { return this.inventory.removeMembers(tenantId, identity.user.id, hotelId, poolId, body, requestIdOf(req)) }

  @Patch('rate-plans/:ratePlanId/release') @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  release(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('ratePlanId') ratePlanId: string, @Body() body: InventoryReleaseRequest, @Req() req: Request) { return this.inventory.setRelease(tenantId, identity.user.id, hotelId, ratePlanId, body, requestIdOf(req)) }
}
