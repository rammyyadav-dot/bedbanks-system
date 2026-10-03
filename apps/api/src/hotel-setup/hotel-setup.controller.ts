import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { HotelSetupSave, HotelSetupStatusChange } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { HotelSetupService } from './hotel-setup.service'

/**
 * Hotel Setup (ADR 0021). Tenant identity comes from the session. Reads need supply.hotels.read (private contacts additionally
 * need supply.hotels.manage); every change needs supply.hotels.manage and carries an idempotency key and the concurrency token.
 */
@ApiTags('admin-hotel-setup')
@Controller('admin/hotels/:hotelId/setup')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class HotelSetupController {
  constructor(private readonly setup: HotelSetupService) {}

  @Get() @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  async get(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string) {
    return this.setup.get(tenantId, hotelId, await this.setup.holds(tenantId, identity.user.id, 'supply.hotels.manage'))
  }

  @Patch() @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  save(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: HotelSetupSave, @Req() req: Request) {
    return this.setup.save(tenantId, identity.user.id, hotelId, body ?? ({} as HotelSetupSave), (req as unknown as { requestId?: string }).requestId ?? null)
  }

  @Post('status') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  status(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: HotelSetupStatusChange, @Req() req: Request) {
    return this.setup.changeStatus(tenantId, identity.user.id, hotelId, body ?? ({} as HotelSetupStatusChange), (req as unknown as { requestId?: string }).requestId ?? null)
  }
}
