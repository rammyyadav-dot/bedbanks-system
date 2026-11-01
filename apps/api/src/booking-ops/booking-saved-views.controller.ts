import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import type { BookingAccessView, SavedViewUpdateRequest, SavedViewWriteRequest } from '@bedbanks/contracts'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { BookingAccess, BookingAccessGuard, RequireBookingAction } from './booking-access.guard'
import { BookingSavedViewsService } from './booking-saved-views.service'

const requestIdOf = (req: Request) => (req as Request & { requestId?: string }).requestId ?? randomUUID()

/**
 * A person's own saved booking views (ADR 0039, Phase 6B). Session, active tenant and the booking access guard on every route; each route declares its permission.
 * The owner is always the authenticated user: there is no way to name another owner, and an administrator has no route into someone else's views.
 */
@ApiTags('admin-booking-views')
@Controller('admin/operations/booking-views')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class BookingSavedViewsController {
  constructor(private readonly views: BookingSavedViewsService) {}

  @Get() @RequireBookingAction('booking.savedview.read') @UseGuards(BookingAccessGuard)
  list(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView) { return this.views.list(tenantId, identity.user.id, access) }

  @Post() @HttpCode(201) @RequireBookingAction('booking.savedview.create') @UseGuards(BookingAccessGuard)
  create(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Body() body: SavedViewWriteRequest) {
    return this.views.create(tenantId, identity.user.id, access, body, requestIdOf(req))
  }

  // Declared before the `:viewId` routes so "default" is never read as a view id.
  @Post('default/clear') @HttpCode(200) @RequireBookingAction('booking.savedview.update.own') @UseGuards(BookingAccessGuard)
  clearDefault(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) { return this.views.clearDefault(tenantId, identity.user.id, requestIdOf(req)) }

  @Get(':viewId') @RequireBookingAction('booking.savedview.read') @UseGuards(BookingAccessGuard)
  one(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Param('viewId') id: string) { return this.views.get(tenantId, identity.user.id, access, id) }

  @Patch(':viewId') @RequireBookingAction('booking.savedview.update.own') @UseGuards(BookingAccessGuard)
  update(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('viewId') id: string, @Body() body: SavedViewUpdateRequest) {
    return this.views.update(tenantId, identity.user.id, access, id, body, requestIdOf(req))
  }

  @Post(':viewId/default') @HttpCode(200) @RequireBookingAction('booking.savedview.update.own') @UseGuards(BookingAccessGuard)
  setDefault(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Param('viewId') id: string) { return this.views.setDefault(tenantId, identity.user.id, id, requestIdOf(req)) }

  @Delete(':viewId') @HttpCode(200) @RequireBookingAction('booking.savedview.delete.own') @UseGuards(BookingAccessGuard)
  remove(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Param('viewId') id: string) { return this.views.remove(tenantId, identity.user.id, id, requestIdOf(req)) }
}
