import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { HotelPublicationDecision, HotelPublicationRequest, HotelSetupSave, HotelSetupStatusChange } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { HotelSetupService } from './hotel-setup.service'
import { HotelPublicationService } from './hotel-publication.service'

/**
 * Hotel Setup (ADR 0021). Tenant identity comes from the session. Reads need supply.hotels.read (private contacts additionally
 * need supply.hotels.manage); every change needs supply.hotels.manage and carries an idempotency key and the concurrency token.
 */
@ApiTags('admin-hotel-setup')
@Controller('admin/hotels/:hotelId/setup')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class HotelSetupController {
  constructor(private readonly setup: HotelSetupService, private readonly publication: HotelPublicationService) {}

  private reqId(req: Request) { return (req as unknown as { requestId?: string }).requestId ?? null }

  @Get() @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  async get(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string) {
    const canManage = await this.setup.holds(tenantId, identity.user.id, 'supply.hotels.manage')
    const view = await this.setup.get(tenantId, hotelId, canManage)
    return { ...view, publication: await this.publication.open(tenantId, identity.user.id, view.hotelId, view.concurrencyToken) }
  }

  @Get('owner-candidates') @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  ownerCandidates(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Query('search') search?: string) { return this.setup.ownerCandidates(tenantId, hotelId, search) }

  @Patch() @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  save(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: HotelSetupSave, @Req() req: Request) {
    return this.setup.save(tenantId, identity.user.id, hotelId, body ?? ({} as HotelSetupSave), (req as unknown as { requestId?: string }).requestId ?? null)
  }

  @Post('status') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  status(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: HotelSetupStatusChange, @Req() req: Request) {
    return this.setup.changeStatus(tenantId, identity.user.id, hotelId, body ?? ({} as HotelSetupStatusChange), (req as unknown as { requestId?: string }).requestId ?? null)
  }

  @Post('publication/request') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  requestPublication(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: HotelPublicationRequest) { return this.publication.request(tenantId, identity.user.id, hotelId, body ?? ({} as HotelPublicationRequest)) }

  @Post('publication/:approvalId/approve') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  approvePublication(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('approvalId') approvalId: string, @Body() body: HotelPublicationDecision) { return this.publication.decide(tenantId, identity.user.id, hotelId, approvalId, 'APPROVED', body) }

  @Post('publication/:approvalId/reject') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  rejectPublication(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('approvalId') approvalId: string, @Body() body: HotelPublicationDecision) { return this.publication.decide(tenantId, identity.user.id, hotelId, approvalId, 'REJECTED', body) }

  @Post('publication/:approvalId/cancel') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  cancelPublication(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('approvalId') approvalId: string) { return this.publication.cancel(tenantId, identity.user.id, hotelId, approvalId) }

  @Post('publication/:approvalId/execute') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  executePublication(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('approvalId') approvalId: string, @Req() req: Request) { return this.publication.execute(tenantId, identity.user.id, hotelId, approvalId, this.reqId(req)) }
}
