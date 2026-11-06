import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { AllocationEditRequest, RoomSalesCommitRequest, RoomSalesPreviewRequest, SalesEligibilityRequest, SupplierStayDecision, SupplierStayRequestBody } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../../auth/guards/session-auth.guard'
import { CurrentUser } from '../../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../../admin-operations/supply-permission.guard'
import { RoomSalesService } from './room-sales.service'

const requestIdOf = (req: Request) => (req as unknown as { requestId?: string }).requestId ?? null

/**
 * Room Availability and Allocation (ADR 0113). Tenant comes from the session.
 * Reading needs supply.availability.read. Changes need supply.availability.manage.
 * Reopening a room-wide Stop Sale also needs supply.hotels.manage, checked in the service.
 */
@ApiTags('admin-room-sales')
@Controller('admin/hotels/:hotelId/inventory')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class RoomSalesController {
  constructor(private readonly sales: RoomSalesService) {}

  @Get('sales/calendar') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  calendar(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Record<string, unknown>) {
    return this.sales.calendar(tenantId, hotelId, query)
  }

  @Post('sales/preview') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  preview(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: RoomSalesPreviewRequest) {
    return this.sales.preview(tenantId, identity.user.id, hotelId, body)
  }

  @Post('sales/commit') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  commit(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: RoomSalesCommitRequest, @Req() req: Request) {
    return this.sales.commit(tenantId, identity.user.id, hotelId, body, requestIdOf(req))
  }

  @Get('sales/history') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  history(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Record<string, unknown>) {
    return this.sales.history(tenantId, hotelId, query)
  }

  @Post('sales/eligibility') @HttpCode(200) @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  eligibility(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Body() body: SalesEligibilityRequest) {
    return this.sales.eligibility(tenantId, hotelId, body)
  }

  @Get('allocation') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  allocation(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query() query: Record<string, unknown>) {
    return this.sales.allocation(tenantId, hotelId, query)
  }

  @Post('allocation/apply') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  applyAllocation(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: AllocationEditRequest, @Req() req: Request) {
    return this.sales.applyAllocation(tenantId, identity.user.id, hotelId, body, requestIdOf(req))
  }

  @Post('allocation/release') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  release(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: { poolId: string; from: string; to: string; weekdays?: string[]; reason: string; idempotencyKey: string; expectedFingerprint: string }, @Req() req: Request) {
    return this.sales.releaseAllocation(tenantId, identity.user.id, hotelId, body, requestIdOf(req))
  }

  @Post('sales/requests') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  createRequest(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: SupplierStayRequestBody) {
    return this.sales.createRequest(tenantId, identity.user.id, hotelId, body)
  }

  @Post('sales/requests/:requestId/decide') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  decide(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('requestId') requestId: string, @Body() body: SupplierStayDecision) {
    return this.sales.decideRequest(tenantId, hotelId, requestId, body)
  }

  @Post('sales/requests/expire') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  expire(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string) {
    return this.sales.expireRequests(tenantId, hotelId)
  }

  @Get('sales/distribution') @RequireSupplyPermission('supply.availability.read') @UseGuards(SupplyPermissionGuard)
  jobs(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string) {
    return this.sales.listDistribution(tenantId, hotelId)
  }

  @Post('sales/distribution/:jobId/deliver') @HttpCode(200) @RequireSupplyPermission('supply.availability.manage') @UseGuards(SupplyPermissionGuard)
  deliver(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('jobId') jobId: string, @Body() body: { forceFailure?: boolean }) {
    return this.sales.deliverDistribution(tenantId, hotelId, jobId, body?.forceFailure === true)
  }
}
