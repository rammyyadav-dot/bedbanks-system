import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { ACTIVE_TENANT_REQUEST_KEY, TenantContextGuard } from '../agent/tenant-context.guard'
import { MappingService } from './mapping.service'

@Controller('supply/mappings')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class MappingController {
  constructor(private readonly mapping: MappingService) {}
  private context(req: Request) {
    return { tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY],
      userId: (req as unknown as { user: AuthenticatedUser }).user.user.id, requestId: req.requestId }
  }
  @Get('options') options(@Req() req: Request) { const c = this.context(req); return this.mapping.options(c.tenantId, c.userId) }
  @Get('options/rooms/:mappingId') roomOptions(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.roomOptions(c.tenantId, c.userId, mappingId) }
  @Get('hotels') hotels(@Req() req: Request) { const c = this.context(req); return this.mapping.hotels(c.tenantId, c.userId) }
  @Get('hotels/:mappingId') hotel(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.hotel(c.tenantId, c.userId, mappingId) }
  @Post('hotels') createHotel(@Req() req: Request, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.createHotel(c.tenantId, c.userId, input, c.requestId) }
  @Patch('hotels/:mappingId') updateHotel(@Req() req: Request, @Param('mappingId') mappingId: string, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.updateHotel(c.tenantId, c.userId, mappingId, input, c.requestId) }
  @Post('hotels/:mappingId/approve') approveHotel(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'hotel', mappingId, 'approve', c.requestId) }
  @Post('hotels/:mappingId/reject') rejectHotel(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'hotel', mappingId, 'reject', c.requestId) }
  @Post('hotels/:mappingId/reopen') reopenHotel(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'hotel', mappingId, 'reopen', c.requestId) }
  @Get('hotels/:mappingId/rooms') rooms(@Req() req: Request, @Param('mappingId') mappingId: string) { const c = this.context(req); return this.mapping.rooms(c.tenantId, c.userId, mappingId) }
  @Get('hotels/:mappingId/rooms/:roomMappingId') room(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string) { const c = this.context(req); return this.mapping.room(c.tenantId, c.userId, mappingId, roomMappingId) }
  @Post('hotels/:mappingId/rooms') createRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.createRoom(c.tenantId, c.userId, mappingId, input, c.requestId) }
  @Patch('hotels/:mappingId/rooms/:roomMappingId') updateRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string, @Body() input: Record<string, unknown>) { const c = this.context(req); return this.mapping.updateRoom(c.tenantId, c.userId, mappingId, roomMappingId, input, c.requestId) }
  @Post('hotels/:mappingId/rooms/:roomMappingId/approve') approveRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'room', roomMappingId, 'approve', c.requestId, mappingId) }
  @Post('hotels/:mappingId/rooms/:roomMappingId/reject') rejectRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'room', roomMappingId, 'reject', c.requestId, mappingId) }
  @Post('hotels/:mappingId/rooms/:roomMappingId/reopen') reopenRoom(@Req() req: Request, @Param('mappingId') mappingId: string, @Param('roomMappingId') roomMappingId: string) { const c = this.context(req); return this.mapping.decide(c.tenantId, c.userId, 'room', roomMappingId, 'reopen', c.requestId, mappingId) }
}
