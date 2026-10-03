import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import { ApiTags } from '@nestjs/swagger'
import type { HotelAmenitiesSave, RoomArchive, RoomSave } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { HotelAmenitiesService } from './hotel-amenities.service'
import { HotelRoomsService } from './hotel-rooms.service'

const rid = (req: Request) => (req as unknown as { requestId?: string }).requestId ?? null

/**
 * Hotel rooms and amenities (ADR 0021). Tenant identity comes from the session. Reads need supply.rooms.read (rooms) or
 * supply.hotels.read (amenities); changes need supply.rooms.manage or supply.hotels.manage. Rooms are archived, never deleted.
 */
@ApiTags('admin-hotel-rooms')
@Controller('admin/hotels/:hotelId')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class HotelRoomsController {
  constructor(private readonly rooms: HotelRoomsService, private readonly amenities: HotelAmenitiesService) {}

  @Get('rooms') @RequireSupplyPermission('supply.rooms.read') @UseGuards(SupplyPermissionGuard)
  list(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string) { return this.rooms.list(tenantId, hotelId) }

  @Post('rooms') @HttpCode(201) @RequireSupplyPermission('supply.rooms.manage') @UseGuards(SupplyPermissionGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: RoomSave, @Req() req: Request) { return this.rooms.create(tenantId, identity.user.id, hotelId, body ?? ({} as RoomSave), rid(req)) }

  @Patch('rooms/:roomId') @HttpCode(200) @RequireSupplyPermission('supply.rooms.manage') @UseGuards(SupplyPermissionGuard)
  update(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('roomId') roomId: string, @Body() body: RoomSave, @Req() req: Request) { return this.rooms.update(tenantId, identity.user.id, hotelId, roomId, body ?? ({} as RoomSave), rid(req)) }

  @Post('rooms/:roomId/archive') @HttpCode(200) @RequireSupplyPermission('supply.rooms.manage') @UseGuards(SupplyPermissionGuard)
  archive(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('roomId') roomId: string, @Body() body: RoomArchive, @Req() req: Request) { return this.rooms.setActive(tenantId, identity.user.id, hotelId, roomId, false, body ?? ({} as RoomArchive), rid(req)) }

  @Post('rooms/:roomId/restore') @HttpCode(200) @RequireSupplyPermission('supply.rooms.manage') @UseGuards(SupplyPermissionGuard)
  restore(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Param('roomId') roomId: string, @Body() body: RoomArchive, @Req() req: Request) { return this.rooms.setActive(tenantId, identity.user.id, hotelId, roomId, true, body ?? ({} as RoomArchive), rid(req)) }

  @Get('amenities') @RequireSupplyPermission('supply.hotels.read') @UseGuards(SupplyPermissionGuard)
  getAmenities(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string) { return this.amenities.get(tenantId, hotelId) }

  @Put('amenities') @HttpCode(200) @RequireSupplyPermission('supply.hotels.manage') @UseGuards(SupplyPermissionGuard)
  saveAmenities(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('hotelId') hotelId: string, @Body() body: HotelAmenitiesSave, @Req() req: Request) { return this.amenities.save(tenantId, identity.user.id, hotelId, body ?? ({} as HotelAmenitiesSave), rid(req)) }
}
