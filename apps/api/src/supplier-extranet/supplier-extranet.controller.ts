import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { ActiveSupplier, SupplierOrganizationGuard } from './supplier-organization.guard'
import { RequireSupplierPermission, SUPPLIER_SELF, SupplierPermissionGuard } from './supplier-permission.guard'
import { SupplierExtranetService } from './supplier-extranet.service'
import { UpdateRoomDraftDto } from './update-room-draft.dto'
import { ListBookingsQueryDto } from './list-bookings.dto'
import { PageQueryDto } from './page-query.dto'
import { SupplierBookingsService } from './supplier-bookings.service'
import { SupplierBookingAnswerService } from './supplier-booking-answer.service'
import { AnswerBookingDto } from './answer-booking.dto'

@Controller('supplier/extranet')
@UseGuards(SessionAuthGuard, TenantContextGuard, SupplierPermissionGuard)
export class SupplierExtranetController {
  constructor(private readonly extranet: SupplierExtranetService, private readonly bookings: SupplierBookingsService, private readonly answers: SupplierBookingAnswerService) {}

  @Get('memberships')
  @RequireSupplierPermission(SUPPLIER_SELF)
  memberships(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    return this.extranet.memberships(tenantId, identity.user.id)
  }

  @Get('context')
  @RequireSupplierPermission(SUPPLIER_SELF)
  @UseGuards(SupplierOrganizationGuard)
  context(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser) {
    return this.extranet.context(tenantId, identity.user.id, supplierId)
  }

  @Get('hotels')
  @RequireSupplierPermission('supplier.extranet.hotels.read')
  @UseGuards(SupplierOrganizationGuard)
  hotels(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: PageQueryDto) {
    return this.extranet.hotels(tenantId, identity.user.id, supplierId, query)
  }

  @Get('hotels/:hotelId')
  @RequireSupplierPermission('supplier.extranet.hotels.read')
  @UseGuards(SupplierOrganizationGuard)
  hotel(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string) {
    return this.extranet.hotel(tenantId, identity.user.id, supplierId, hotelId)
  }

  @Get('hotels/:hotelId/rooms')
  @RequireSupplierPermission('supplier.extranet.rooms.read')
  @UseGuards(SupplierOrganizationGuard)
  rooms(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string) {
    return this.extranet.rooms(tenantId, identity.user.id, supplierId, hotelId)
  }

  @Get('contracts')
  @RequireSupplierPermission('supplier.extranet.contracts.read')
  @UseGuards(SupplierOrganizationGuard)
  contracts(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: PageQueryDto) {
    return this.extranet.contracts(tenantId, identity.user.id, supplierId, query)
  }

  @Get('bookings')
  @RequireSupplierPermission('supplier.extranet.bookings.read')
  @UseGuards(SupplierOrganizationGuard)
  listBookings(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Query() query: ListBookingsQueryDto) {
    return this.bookings.list(tenantId, identity.user.id, supplierId, query)
  }

  @Get('bookings/:bookingId')
  @RequireSupplierPermission('supplier.extranet.bookings.read')
  @UseGuards(SupplierOrganizationGuard)
  booking(@ActiveTenant() tenantId: string, @ActiveSupplier() supplierId: string, @CurrentUser() identity: AuthenticatedUser, @Param('bookingId') bookingId: string) {
    return this.bookings.detail(tenantId, identity.user.id, supplierId, bookingId)
  }

  @Post('bookings/:bookingId/answer')
  @RequireSupplierPermission('supplier.extranet.bookings.answer')
  @HttpCode(200)
  @UseGuards(SupplierOrganizationGuard)
  answer(
    @Req() request: Request,
    @ActiveTenant() tenantId: string,
    @ActiveSupplier() supplierId: string,
    @CurrentUser() identity: AuthenticatedUser,
    @Param('bookingId') bookingId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: AnswerBookingDto,
  ) {
    return this.answers.answer(tenantId, identity.user.id, supplierId, bookingId, body, key, request.requestId)
  }

  @Patch('hotels/:hotelId/rooms/:roomId/draft')
  @RequireSupplierPermission('supplier.extranet.drafts.manage')
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
