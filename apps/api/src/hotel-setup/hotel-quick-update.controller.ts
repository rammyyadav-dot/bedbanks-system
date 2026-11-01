import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { QuickUpdateApply, QuickUpdateRequest } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { HotelQuickUpdateService } from './hotel-quick-update.service'

/**
 * Quick Update (ADR 0021, stage 5). Tenant identity comes from the session. Both calls need supply.rates.read; the service also
 * requires supply.rates.manage for a price change and supply.availability.manage for an availability or restriction change.
 */
@ApiTags('admin-hotel-quick-update')
@Controller('admin/hotels/:hotelId/quick-update')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class HotelQuickUpdateController {
  constructor(private readonly quick: HotelQuickUpdateService) {}

  @Post('preview') @HttpCode(200) @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  preview(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: QuickUpdateRequest) { return this.quick.preview(tenantId, identity.user.id, hotelId, body) }

  @Post('apply') @HttpCode(200) @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  apply(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: QuickUpdateApply, @Req() req: Request) { return this.quick.apply(tenantId, identity.user.id, hotelId, body, (req as unknown as { requestId?: string }).requestId ?? null) }
}
