import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import type { BookingAccessView, BookingOpsAcknowledgeRequest, BookingOpsAnswerRequest, BookingOpsAssignRequest, BookingOpsClearRequest, BookingOpsEscalateRequest, BookingOpsNoteRequest } from '@bedbanks/contracts'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { BookingAccess, BookingAccessGuard, RequireBookingAction } from './booking-access.guard'
import { BookingOpsQueueService } from './booking-ops-queue.service'
import { BookingOpsService } from './booking-ops.service'

const requestIdOf = (req: Request) => (req as Request & { requestId?: string }).requestId ?? randomUUID()

/**
 * The booking operations queue (ADR 0039, Phase 4). Every route needs a session, the active tenant, the booking access guard (formal permission, operator level) and, for a
 * mutation, an Idempotency-Key. Tenant identity is the session's. Reads never write; mutations never call a supplier (the Phase 3 queue does that, elsewhere).
 */
@ApiTags('admin-booking-queue')
@Controller('admin/operations/booking-queue')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class BookingOpsController {
  constructor(private readonly queue: BookingOpsQueueService, private readonly ops: BookingOpsService) {}

  @Get() @RequireBookingAction('booking.ops.view') @UseGuards(BookingAccessGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Query() query: Record<string, unknown>) {
    return this.queue.list(tenantId, identity.user.id, access, query)
  }

  // Declared before the `:bookingId` routes so "assignees" is never read as a booking id.
  @Get('assignees') @RequireBookingAction('booking.ops.view') @UseGuards(BookingAccessGuard)
  assignees(@ActiveTenant() tenantId: string, @BookingAccess() access: BookingAccessView) { return this.ops.assignees(tenantId, access) }

  @Get(':bookingId') @RequireBookingAction('booking.ops.view') @UseGuards(BookingAccessGuard)
  item(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Param('bookingId') bookingId: string) { return this.queue.panel(tenantId, identity.user.id, access, bookingId) }

  @Post(':bookingId/assign') @HttpCode(200) @RequireBookingAction('booking.ops.assign') @UseGuards(BookingAccessGuard)
  assign(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingOpsAssignRequest) {
    return this.ops.assign(tenantId, identity.user.id, access, id, body, key, requestIdOf(req))
  }

  @Post(':bookingId/acknowledge') @HttpCode(200) @RequireBookingAction('booking.ops.assign') @UseGuards(BookingAccessGuard)
  acknowledge(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingOpsAcknowledgeRequest) {
    return this.ops.acknowledge(tenantId, identity.user.id, access, id, body, key, requestIdOf(req))
  }

  @Post(':bookingId/escalate') @HttpCode(200) @RequireBookingAction('booking.ops.escalate') @UseGuards(BookingAccessGuard)
  escalate(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingOpsEscalateRequest) {
    return this.ops.escalate(tenantId, identity.user.id, access, id, body, key, requestIdOf(req))
  }

  @Post(':bookingId/note') @HttpCode(200) @RequireBookingAction('booking.ops.note') @UseGuards(BookingAccessGuard)
  note(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingOpsNoteRequest) {
    return this.ops.note(tenantId, identity.user.id, access, id, body, key, requestIdOf(req))
  }

  @Post(':bookingId/clear') @HttpCode(200) @RequireBookingAction('booking.ops.resolve') @UseGuards(BookingAccessGuard)
  clear(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingOpsClearRequest) {
    return this.ops.clearFollowUp(tenantId, identity.user.id, access, id, body, key, requestIdOf(req))
  }

  @Post(':bookingId/supplier-answer') @HttpCode(200) @RequireBookingAction('booking.ops.resolve') @UseGuards(BookingAccessGuard)
  answer(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') id: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingOpsAnswerRequest) {
    return this.ops.answer(tenantId, identity.user.id, access, id, body, key, requestIdOf(req))
  }
}
