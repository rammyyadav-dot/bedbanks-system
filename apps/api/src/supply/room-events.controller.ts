import { Body, Controller, Get, Param, Post, Patch, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import type { RoomEventApprovalDecisionInput, RoomEventTransitionInput, RoomEventUpdate, RoomEventWrite } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { TenantContextGuard, ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { RoomEventsService } from './room-events.service'

/** Routes live in @bedbanks/contracts (supplyRoutes.roomEvent*). Tenant and user come only from the session (CLAUDE.md invariant 1);
 * every handler declares the permission its service method enforces (invariant 2). */
@Controller('admin')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class RoomEventsController {
  constructor(private readonly roomEvents: RoomEventsService) {}
  private context(req: Request) {
    const user = (req as unknown as { user: AuthenticatedUser }).user
    return { tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY], userId: user.user.id, requestId: (req as unknown as { requestId?: string }).requestId ?? req.header('x-request-id') ?? undefined }
  }

  @Get('room-events') @RequireSupplyPermission('supply.room_events.read') @UseGuards(SupplyPermissionGuard)
  list(@Req() req: Request, @Query() query: Record<string, unknown>) { const c = this.context(req); return this.roomEvents.list(c.tenantId, query) }

  @Get('room-events/:roomEventId') @RequireSupplyPermission('supply.room_events.read') @UseGuards(SupplyPermissionGuard)
  get(@Req() req: Request, @Param('roomEventId') roomEventId: string) { const c = this.context(req); return this.roomEvents.get(c.tenantId, roomEventId) }

  @Post('room-events') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  create(@Req() req: Request, @Body() body: RoomEventWrite) { const c = this.context(req); return this.roomEvents.create(c.tenantId, c.userId, body) }

  @Patch('room-events/:roomEventId') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  update(@Req() req: Request, @Param('roomEventId') roomEventId: string, @Body() body: RoomEventUpdate) { const c = this.context(req); return this.roomEvents.update(c.tenantId, c.userId, roomEventId, body) }

  @Post('room-events/:roomEventId/submit') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  submit(@Req() req: Request, @Param('roomEventId') roomEventId: string, @Body() body: RoomEventTransitionInput) { const c = this.context(req); return this.roomEvents.submit(c.tenantId, c.userId, roomEventId, body, c.requestId) }

  @Post('room-events/:roomEventId/cancel') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  cancel(@Req() req: Request, @Param('roomEventId') roomEventId: string, @Body() body: RoomEventTransitionInput) { const c = this.context(req); return this.roomEvents.cancel(c.tenantId, c.userId, roomEventId, body) }

  @Post('room-events/:roomEventId/archive') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  archive(@Req() req: Request, @Param('roomEventId') roomEventId: string, @Body() body: RoomEventTransitionInput) { const c = this.context(req); return this.roomEvents.archive(c.tenantId, c.userId, roomEventId, body) }

  @Post('room-event-approvals/:approvalId/approve') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  approve(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: RoomEventApprovalDecisionInput) { const c = this.context(req); return this.roomEvents.decide(c.tenantId, c.userId, approvalId, 'APPROVED', body) }

  @Post('room-event-approvals/:approvalId/reject') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  reject(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: RoomEventApprovalDecisionInput) { const c = this.context(req); return this.roomEvents.decide(c.tenantId, c.userId, approvalId, 'REJECTED', body) }

  @Post('room-event-approvals/:approvalId/cancel') @RequireSupplyPermission('supply.room_events.manage') @UseGuards(SupplyPermissionGuard)
  cancelApproval(@Req() req: Request, @Param('approvalId') approvalId: string) { const c = this.context(req); return this.roomEvents.cancelApproval(c.tenantId, c.userId, approvalId) }
}
