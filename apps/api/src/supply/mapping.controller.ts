import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ACTIVE_TENANT_REQUEST_KEY, TenantContextGuard } from '../agent/tenant-context.guard'
import type { HotelMappingApproveBody, HotelMappingSuggestionQuery } from '@bedbanks/contracts'
import { MappingService } from './mapping.service'

@Controller('supply/mappings')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class MappingController {
  constructor(private readonly mapping: MappingService) {}
  private context(req: Request) {
    return { tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY],
      userId: (req as unknown as { user: AuthenticatedUser }).user.user.id, requestId: req.requestId }
  }
  @Get('options') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard) options(@Req() req: Request) { const c = this.context(req); return this.mapping.options(c.tenantId, c.userId) }
  @Get('options/rooms/:mappingId') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard) roomOptions(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.roomOptions(c.tenantId, c.userId, mappingId) }
  // Declared before hotels/:mappingId so the literal segment is not captured as a mapping id.
  @Get('hotels/suggestions') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard) suggestHotels(@Req() req: Request, @Query() query: HotelMappingSuggestionQuery) { const c = this.context(req); return this.mapping.suggestHotels(c.tenantId, c.userId, query) }
  @Get('hotels') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard) hotels(@Req() req: Request) { const c = this.context(req); return this.mapping.hotels(c.tenantId, c.userId) }
  @Get('hotels/:mappingId') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard) hotel(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.hotel(c.tenantId, c.userId, mappingId) }
  @Post('hotels') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) createHotel(@Req() req: Request, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.createHotel(c.tenantId, c.userId, input, c.requestId) }
  @Patch('hotels/:mappingId') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) updateHotel(@Req() req: Request, @Param('mappingId') mappingId: string, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.updateHotel(c.tenantId, c.userId, mappingId, input, c.requestId) }
  @Post('hotels/:mappingId/approve') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) approveHotel(@Req() req: Request, @Param('mappingId') mappingId: string, @Body() body?: HotelMappingApproveBody) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'hotel', mappingId, 'approve', c.requestId, undefined, body?.reason, body?.acknowledgeDuplicateHotelIds) }
  @Post('hotels/:mappingId/reject') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) rejectHotel(@Req() req: Request, @Param('mappingId') mappingId: string, @Body() body?: { reason?: string }) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'hotel', mappingId, 'reject', c.requestId, undefined, body?.reason) }
  @Post('hotels/:mappingId/reopen') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) reopenHotel(@Req() req: Request, @Param('mappingId') mappingId: string, @Body() body?: { reason?: string }) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'hotel', mappingId, 'reopen', c.requestId, undefined, body?.reason) }
  @Get('hotels/:mappingId/rooms') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard) rooms(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.rooms(c.tenantId, c.userId, mappingId) }
  @Get('hotels/:mappingId/rooms/:roomMappingId') @RequireSupplyPermission('supply.mappings.read') @UseGuards(SupplyPermissionGuard) room(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string) { const c = this.context(req); return this.mapping.room(c.tenantId, c.userId, mappingId, roomMappingId) }
  @Post('hotels/:mappingId/rooms') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) createRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.createRoom(c.tenantId, c.userId, mappingId, input, c.requestId) }
  @Patch('hotels/:mappingId/rooms/:roomMappingId') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) updateRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.updateRoom(c.tenantId, c.userId, mappingId, roomMappingId, input, c.requestId) }
  @Post('hotels/:mappingId/rooms/:roomMappingId/approve') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) approveRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string, @Body() body?: { reason?: string }) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'room', roomMappingId, 'approve', c.requestId, mappingId, body?.reason) }
  @Post('hotels/:mappingId/rooms/:roomMappingId/reject') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) rejectRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string, @Body() body?: { reason?: string }) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'room', roomMappingId, 'reject', c.requestId, mappingId, body?.reason) }
  @Post('hotels/:mappingId/rooms/:roomMappingId/reopen') @RequireSupplyPermission('supply.mappings.manage') @UseGuards(SupplyPermissionGuard) reopenRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string, @Body() body?: { reason?: string }) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'room', roomMappingId, 'reopen', c.requestId, mappingId, body?.reason) }
}
