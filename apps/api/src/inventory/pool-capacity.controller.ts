import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { PoolCapacityApply, PoolCapacityEditRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { PoolCapacityService } from './pool-capacity.service'

const requestIdOf = (req: Request) => (req as unknown as { requestId?: string }).requestId ?? null

/**
 * Pool detail, per-plan consumption and the capacity editor (ADR 0036). Tenant identity comes from the session. Three separate grants:
 * viewing (supply.availability.read), previewing an edit (supply.pool_capacity.preview) and applying one (supply.pool_capacity.apply).
 * Previewing writes nothing. Applying needs a fingerprint from a preview, a reason and an idempotency key.
 */
@ApiTags('admin-hotel-inventory')
@Controller('admin/hotels/:hotelId/inventory')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class PoolCapacityController {
  constructor(private readonly pools: PoolCapacityService) {}

  @Get('pools/:poolId') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  detail(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Query() query: { from?: unknown; days?: unknown }) { return this.pools.detail(tenantId, hotelId, poolId, query) }

  @Get('pools/:poolId/consumption') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  consumption(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Query() query: { from?: unknown; days?: unknown }) { return this.pools.consumption(tenantId, hotelId, poolId, query) }

  @Post('pools/:poolId/capacity/preview') @HttpCode(200) @RequireSupplyPermission('supply.pool_capacity.preview') @UseGuards(SupplyPermissionGuard)
  preview(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: PoolCapacityEditRequest) { return this.pools.preview(tenantId, hotelId, poolId, body) }

  @Post('pools/:poolId/capacity/apply') @HttpCode(200) @RequireSupplyPermission('supply.pool_capacity.apply') @UseGuards(SupplyPermissionGuard)
  apply(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: PoolCapacityApply, @Req() req: Request) { return this.pools.apply(tenantId, identity.user.id, hotelId, poolId, body, requestIdOf(req)) }
}
