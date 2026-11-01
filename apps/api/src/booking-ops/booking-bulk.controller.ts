import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import type { BookingAccessView } from '@bedbanks/contracts'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { BookingAccess, BookingAccessGuard, RequireBookingAction } from './booking-access.guard'
import { BookingBulkService } from './booking-bulk.service'

const requestIdOf = (req: Request) => (req as Request & { requestId?: string }).requestId ?? randomUUID()

/**
 * Bulk actions on bookings (ADR 0039, Phase 6C). Session, active tenant and the booking access guard on every route; the tenant and the actor are the session's. The route
 * declares that the caller holds one of the bulk capabilities; the service checks the exact one for the requested action, and the single-booking service checks the
 * underlying permission for every booking.
 */
@ApiTags('admin-booking-bulk')
@Controller('admin/operations')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class BookingBulkController {
  constructor(private readonly bulk: BookingBulkService) {}

  @Post('bookings/bulk-actions') @HttpCode(200) @RequireBookingAction('booking.bulk.assign', 'booking.bulk.acknowledge') @UseGuards(BookingAccessGuard)
  submit(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Body() body: unknown) {
    return this.bulk.submit(tenantId, identity.user.id, access, body, requestIdOf(req))
  }

  @Get('booking-bulk-actions/:operationId') @RequireBookingAction('booking.bulk.read') @UseGuards(BookingAccessGuard)
  one(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Param('operationId') operationId: string) { return this.bulk.get(tenantId, identity.user.id, operationId) }
}
