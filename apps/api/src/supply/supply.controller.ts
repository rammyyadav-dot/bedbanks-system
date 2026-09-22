import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { TenantContextGuard, ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import { SupplyService } from './supply.service'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'

@Controller('supply')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class SupplyController {
  constructor(private readonly supply: SupplyService) {}
  private context(req: Request) { const user = (req as unknown as { user: AuthenticatedUser }).user; const tenantId = (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY]; return { tenantId, userId: user.user.id, requestId: req.header('x-request-id') ?? undefined } }
  @Get('hotels') hotels(@Req() req: Request) { const c = this.context(req); return this.supply.hotels(c.tenantId, c.userId) }
  @Get('hotels/:hotelId') hotel(@Req() req: Request, @Param('hotelId') hotelId: string) { const c = this.context(req); return this.supply.hotel(c.tenantId, c.userId, hotelId) }
  @Post('hotels') createHotel(@Req() req: Request, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.createHotel(c.tenantId, c.userId, body, c.requestId) }
  @Patch('hotels/:hotelId') updateHotel(@Req() req: Request, @Param('hotelId') hotelId: string, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.updateHotel(c.tenantId, c.userId, hotelId, body, c.requestId) }
  @Get('room-types') roomTypes(@Req() req: Request) { const c = this.context(req); return this.supply.roomTypes(c.tenantId, c.userId) }
  @Post('room-types') createRoomType(@Req() req: Request, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.createRoomType(c.tenantId, c.userId, body, c.requestId) }
  @Get('board-bases') boardBases(@Req() req: Request) { const c = this.context(req); return this.supply.boardBases(c.tenantId, c.userId) }
  @Get('contracts') contracts(@Req() req: Request) { const c = this.context(req); return this.supply.contracts(c.tenantId, c.userId) }
  @Post('contracts') createContract(@Req() req: Request, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.createContract(c.tenantId, c.userId, body, c.requestId) }
  @Get('rate-plans') ratePlans(@Req() req: Request) { const c = this.context(req); return this.supply.ratePlans(c.tenantId, c.userId) }
  @Post('rate-plans') createRatePlan(@Req() req: Request, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.createRatePlan(c.tenantId, c.userId, body, c.requestId) }
  @Post('daily-rates') dailyRate(@Req() req: Request, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.upsertDailyRate(c.tenantId, c.userId, body, c.requestId) }
  @Post('availability') availability(@Req() req: Request, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.upsertAvailability(c.tenantId, c.userId, body, c.requestId) }
  @Post('sellability') sellability(@Req() req: Request, @Body() body: Record<string, unknown>) { const c = this.context(req); return this.supply.sellability(c.tenantId, c.userId, body) }
}
