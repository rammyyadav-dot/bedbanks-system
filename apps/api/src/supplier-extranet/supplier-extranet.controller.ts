import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { ActiveSupplier, SupplierOrganizationGuard } from './supplier-organization.guard'
import { SupplierExtranetService } from './supplier-extranet.service'
import { UpdateRoomDraftDto } from './update-room-draft.dto'

@Controller('supplier/extranet')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class SupplierExtranetController {
  constructor(private readonly extranet: SupplierExtranetService) {}

  @Get('memberships')
  memberships(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    return this.extranet.memberships(tenantId, identity.user.id)
  }

  @Get('context')
  @UseGuards(SupplierOrganizationGuard)
  context(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser) {
    return this.extranet.context(tenantId, identity.user.id, supplierId)
  }

  @Get('hotels')
  @UseGuards(SupplierOrganizationGuard)
  hotels(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser) {
    return this.extranet.hotels(tenantId, identity.user.id, supplierId)
  }

  @Get('hotels/:hotelId')
  @UseGuards(SupplierOrganizationGuard)
  hotel(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string) {
    return this.extranet.hotel(tenantId, identity.user.id, supplierId, hotelId)
  }

  @Get('hotels/:hotelId/rooms')
  @UseGuards(SupplierOrganizationGuard)
  rooms(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string) {
    return this.extranet.rooms(tenantId, identity.user.id, supplierId, hotelId)
  }

  @Patch('hotels/:hotelId/rooms/:roomId/draft')
  @UseGuards(SupplierOrganizationGuard)
  saveDraft(
    @Req() request: Request,
    @ActiveTenant() tenantId: string,
    @ActiveSupplier() supplierId: string,
    @CurrentUser() identity: AuthenticatedUser,
    @Param('hotelId') hotelId: string,
    @Param('roomId') roomId: string,
    @Body() body: UpdateRoomDraftDto,
  ) {
    return this.extranet.saveRoomDraft(tenantId, identity.user.id, supplierId, hotelId, roomId, body.supplierNotes, request.requestId)
  }
}
