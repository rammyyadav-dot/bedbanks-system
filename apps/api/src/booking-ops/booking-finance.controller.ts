import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import { bookingDocumentTypeFromRoute, type BookingAccessView, type BookingPenaltyRequest } from '@bedbanks/contracts'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { BookingAccess, BookingAccessGuard, RequireBookingAction } from './booking-access.guard'
import { BookingFinanceService } from './booking-finance.service'

const requestIdOf = (req: Request) => (req as Request & { requestId?: string }).requestId ?? randomUUID()
const typeOf = (value: string) => { const t = bookingDocumentTypeFromRoute(value); if (!t) throw new BadRequestException({ message: 'Unknown document type', code: 'UNKNOWN_DOCUMENT_TYPE' }); return t }

/**
 * Money and documents of an Admin booking (ADR 0039, Phase 5). Session + active tenant + the booking access guard (a formal permission, operator level) on every route; the
 * tenant is the session's. Reads never write. Nothing here posts to a ledger or calls a supplier.
 */
@ApiTags('admin-booking-finance')
@Controller('admin/operations/booking-finance')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class BookingFinanceController {
  constructor(private readonly finance: BookingFinanceService) {}

  @Get(':bookingId') @RequireBookingAction('booking.finance.view') @UseGuards(BookingAccessGuard)
  view(@ActiveTenant() tenantId: string, @BookingAccess() access: BookingAccessView, @Param('bookingId') bookingId: string) { return this.finance.view(tenantId, access, bookingId) }

  @Post(':bookingId/penalty') @HttpCode(200) @RequireBookingAction('booking.cancel.nonrefundable', 'booking.penalty.waive.approve') @UseGuards(BookingAccessGuard)
  penalty(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') bookingId: string, @Headers('idempotency-key') key: string | undefined, @Body() body: BookingPenaltyRequest) {
    return this.finance.changePenalty(tenantId, identity.user.id, access, bookingId, body, key, requestIdOf(req))
  }

  @Post(':bookingId/documents/:type') @HttpCode(200) @RequireBookingAction('booking.documents.issue') @UseGuards(BookingAccessGuard)
  issue(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @BookingAccess() access: BookingAccessView, @Req() req: Request, @Param('bookingId') bookingId: string, @Param('type') type: string) {
    return this.finance.issueDocument(tenantId, identity.user.id, access, bookingId, typeOf(type), requestIdOf(req))
  }

  @Get(':bookingId/documents/:type/html') @RequireBookingAction('booking.documents.issue') @UseGuards(BookingAccessGuard)
  async html(@ActiveTenant() tenantId: string, @BookingAccess() access: BookingAccessView, @Param('bookingId') bookingId: string, @Param('type') type: string, @Res() response: Response) {
    const html = await this.finance.documentHtml(tenantId, access, bookingId, typeOf(type))
    // Explicit headers because @Res() takes over the response: no scripts, no external resources, never cached.
    response.status(200).set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(html)
  }
}
