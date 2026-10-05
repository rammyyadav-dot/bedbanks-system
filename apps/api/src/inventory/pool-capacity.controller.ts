import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { PoolCapacityApply, PoolCapacityEditRequest, PoolNightDecision, PoolNightRequestBody } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { PoolCapacityService } from './pool-capacity.service'
import { PoolNightRequestService } from './pool-night-request.service'

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
  constructor(private readonly pools: PoolCapacityService, private readonly nights: PoolNightRequestService) {}

  @Get('pools/:poolId') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  detail(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Query() query: { from?: unknown; days?: unknown }) { return this.pools.detail(tenantId, hotelId, poolId, query) }

  @Get('pools/:poolId/consumption') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  consumption(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Query() query: { from?: unknown; days?: unknown }) { return this.pools.consumption(tenantId, hotelId, poolId, query) }

  @Post('pools/:poolId/capacity/preview') @HttpCode(200) @RequireSupplyPermission('supply.pool_capacity.preview') @UseGuards(SupplyPermissionGuard)
  preview(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: PoolCapacityEditRequest) { return this.pools.preview(tenantId, hotelId, poolId, body) }

  @Post('pools/:poolId/capacity/apply') @HttpCode(200) @RequireSupplyPermission('supply.pool_capacity.apply') @UseGuards(SupplyPermissionGuard)
  apply(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: PoolCapacityApply, @Req() req: Request) { return this.pools.apply(tenantId, identity.user.id, hotelId, poolId, body, requestIdOf(req)) }

  // Requests to open new nights (ADR 0036 Amendment 3): maker-checker only; the database owner applies an approved request.
  @Get('pools/:poolId/night-requests') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  nightRequests(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string) { return this.nights.list(tenantId, identity.user.id, hotelId, poolId) }

  @Post('pools/:poolId/night-requests') @HttpCode(200) @RequireSupplyPermission('supply.pool_nights.request') @UseGuards(SupplyPermissionGuard)
  requestNights(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Body() body: PoolNightRequestBody) { return this.nights.request(tenantId, identity.user.id, hotelId, poolId, body) }

  @Post('pools/:poolId/night-requests/:approvalId/approve') @HttpCode(200) @RequireSupplyPermission('supply.pool_nights.decide') @UseGuards(SupplyPermissionGuard)
  approveNights(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Param('approvalId') approvalId: string, @Body() body: PoolNightDecision) { return this.nights.decide(tenantId, identity.user.id, hotelId, poolId, approvalId, 'APPROVED', body) }

  @Post('pools/:poolId/night-requests/:approvalId/reject') @HttpCode(200) @RequireSupplyPermission('supply.pool_nights.decide') @UseGuards(SupplyPermissionGuard)
  rejectNights(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Param('approvalId') approvalId: string, @Body() body: PoolNightDecision) { return this.nights.decide(tenantId, identity.user.id, hotelId, poolId, approvalId, 'REJECTED', body) }

  @Post('pools/:poolId/night-requests/:approvalId/cancel') @HttpCode(200) @RequireSupplyPermission('supply.pool_nights.request') @UseGuards(SupplyPermissionGuard)
  cancelNights(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('poolId') poolId: string, @Param('approvalId') approvalId: string) { return this.nights.cancel(tenantId, identity.user.id, hotelId, poolId, approvalId) }
}
