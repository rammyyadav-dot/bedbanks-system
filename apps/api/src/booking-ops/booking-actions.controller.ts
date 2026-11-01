import { Body, Controller, Headers, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import type { BookingAccessView, BookingActionRequest, BookingReferencesRequest, BookingSupplierRequest, ManualBookingRequest } from '@bedbanks/contracts'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { BookingAccess, BookingAccessGuard, RequireBookingAction } from './booking-access.guard'
import { BookingActionsService } from './booking-actions.service'
import { BookingSupplierJobsService } from './booking-supplier-jobs.service'

const requestIdOf = (req: Request) => (req as Request & { requestId?: string }).requestId ?? randomUUID()

/**
 * Booking writes (ADR 0039, Phase 2). Every route needs a session, an active tenant, the booking access guard (which resolves the caller's formal permissions)
 * and an Idempotency-Key. Each route declares the permissions of which the caller must hold one; the service then checks the one that authorises the named
 * action on this booking. Tenant identity is the session's, never the body's.
 */
@ApiTags('admin-bookings')
@Controller('admin/operations/bookings')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class BookingActionsController {
  constructor(private readonly actions: BookingActionsService, private readonly supplierJobs: BookingSupplierJobsService) {}

  @Post(':bookingId/actions') @HttpCode(200)
  @RequireBookingAction(
    'booking.confirm.manual', 'booking.on-request.resolve', 'booking.amend', 'booking.amend.request', 'booking.cancel', 'booking.cancel.request', 'booking.cancel.nonrefundable', 'booking.no-show.mark', 'booking.rebook',
  )
  @UseGuards(BookingAccessGuard)
  act(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') bookingId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingActionRequest) {
    return this.actions.act(tenantId, identity.user.id, access, bookingId, body, key, requestIdOf(req))
  }

  @Patch(':bookingId/references') @HttpCode(200)
  @RequireBookingAction('booking.supplier-ref.edit')
  @UseGuards(BookingAccessGuard)
  references(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') bookingId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingReferencesRequest) {
    return this.actions.editReferences(tenantId, identity.user.id, access, bookingId, body, key, requestIdOf(req))
  }

  @Post(':bookingId/supplier') @HttpCode(200)
  @RequireBookingAction('booking.supplier.retry')
  @UseGuards(BookingAccessGuard)
  supplier(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') bookingId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingSupplierRequest) {
    return this.supplierJobs.request(tenantId, identity.user.id, access, bookingId, body, key, requestIdOf(req))
  }

  @Post()
  @RequireBookingAction('booking.manual.create')
  @UseGuards(BookingAccessGuard)
  createManual(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Headers('idempotency-key') key: string | undefined, @Body() body: ManualBookingRequest) {
    return this.actions.createManual(tenantId, identity.user.id, access, body, key, requestIdOf(req))
  }
}
