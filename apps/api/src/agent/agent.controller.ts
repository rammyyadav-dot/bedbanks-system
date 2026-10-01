import { BadRequestException, Body, Controller, Delete, Get, HttpStatus, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentAuditService } from './audit.service'
import { CancellationDto, OfferHoldDto, OfferHoldParamsDto, OfferRecheckDto, ReconcileBookingsDto, PrebookBookingDto, ConfirmBookingDto } from './domain.dto'
import { AgentFinanceService } from './finance.service'
import { AgentRbacGuard, RequirePermission } from './rbac.guard'
import { SupplierAdapter, SUPPLIER_ADAPTER, HotelSearchCriteria, PERMISSIONS } from './supplier.port'
import { ACTIVE_TENANT_REQUEST_KEY, ActiveTenant, TenantContextGuard } from './tenant-context.guard'
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { SUPPORTED_SETTLEMENT_CURRENCIES } from './currency'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import { OfferHoldService } from './offer-hold.service'
import { AgentSearchService } from './agent-search.service'
import { BookingReconciliationService } from './booking-reconciliation.service'
import { BookingTransactionService, bookingEnabled } from './booking-transaction.service'
import { BookingCancellationService } from './booking-cancellation.service'
import { BookingDocumentService, documentKindFromRoute } from './booking-document.service'
import { BookingQueryService } from './booking-query.service'
import { InventoryHoldService } from './inventory-hold.service'
import { renderBookingDocument } from './booking-document.render'

class SearchFiltersDto {
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(1, { each: true }) @Max(5, { each: true }) starRatings?: number[]
  @IsOptional() @IsArray() @IsString({ each: true }) boardBasisIds?: string[]
  @IsOptional() @IsBoolean() refundableOnly?: boolean
  @IsOptional() @IsInt() @Min(0) minPriceMinor?: number
  @IsOptional() @IsInt() @Min(0) maxPriceMinor?: number
}

class SearchHotelsDto implements HotelSearchCriteria {
  @IsString() destination!: string
  @IsOptional() @IsArray() @IsString({ each: true }) canonicalHotelIds?: string[]
  @IsDateString() checkIn!: string
  @IsDateString() checkOut!: string
  @IsInt() @Min(1) rooms!: number
  @IsInt() @Min(1) adults!: number
  @IsInt() @Min(0) children!: number
  @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(17, { each: true }) childAges!: number[]
  @IsString() nationality!: string
  @IsOptional() @IsIn(SUPPORTED_SETTLEMENT_CURRENCIES) currency = 'USD'
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number
  @IsOptional() @ValidateNested() @Type(() => SearchFiltersDto) filters?: SearchFiltersDto
}

@ApiTags('agent')
@Controller('agent')
@UseGuards(SessionAuthGuard)
export class AgentController {
  constructor(
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
    private readonly financeService: AgentFinanceService,
    private readonly audit: AgentAuditService,
    private readonly offerHolds: OfferHoldService,
    private readonly agentSearch: AgentSearchService,
    private readonly reconciliation: BookingReconciliationService,
    private readonly bookingTx: BookingTransactionService,
    private readonly cancellations: BookingCancellationService,
    private readonly documents: BookingDocumentService,
    private readonly bookingQueries: BookingQueryService,
    private readonly inventoryHolds: InventoryHoldService,
  ) {}

  @Get('context')
  @ApiOperation({ summary: 'Return authenticated agent context and memberships' })
  context(@CurrentUser() identity: AuthenticatedUser) {
    return { user: identity.user, memberships: identity.memberships, capabilities: Object.values(PERMISSIONS), bookingEnabled: bookingEnabled() }
  }

  @Post('offers/:offerId/hold')
  @ApiOperation({ summary: 'Authoritatively recheck a canonical offer and create a non-bookable inventory hold' })
  @RequirePermission(PERMISSIONS.prebook)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async holdOffer(@Param() params: OfferHoldParamsDto, @Body() body: OfferHoldDto,
    @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    const tenantId = (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY]
    const result = await this.offerHolds.execute({ offerId: params.offerId, searchId: body.searchId,
      expectedCurrency: body.expectedCurrency, expectedSellAmountMinor: body.expectedSellAmountMinor,
      idempotencyKey: body.idempotencyKey, tenantId, user: identity, requestId: req.requestId ?? randomUUID() })
    const statusCodes = { rechecked: HttpStatus.OK, held: HttpStatus.CREATED, unavailable: HttpStatus.CONFLICT, price_changed: HttpStatus.CONFLICT,
      offer_expired: HttpStatus.GONE, mapping_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
      provider_unavailable: HttpStatus.SERVICE_UNAVAILABLE, rejected: HttpStatus.BAD_REQUEST } as const
    const holdStatus = result.status === 'rechecked' ? 'rejected' : result.status
    response.status(statusCodes[holdStatus])
    return result
  }

  @Post('search/status')
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async searchStatus(@Body() criteria: SearchHotelsDto) {
    if (!validSearchCriteria(criteria)) throw new BadRequestException('Invalid search criteria')
    return { status: this.supplier.name === 'unconfigured' ? 'provider_unavailable' : 'not_checked' }
  }

  @Post('search')
  @ApiOperation({ summary: 'Version 1 canonical hotel, room and rate offers; booking stays unavailable' })
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async search(@Body() criteria: SearchHotelsDto, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    if (!validSearchCriteria(criteria)) throw new BadRequestException('Invalid search criteria')
    const tenantId = (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY]
    return this.agentSearch.execute(criteria, tenantId, req.requestId ?? randomUUID(), identity)
  }

  @Delete('holds/:holdId')
  @ApiOperation({ summary: 'Release your own un-booked inventory hold before it expires' })
  @RequirePermission(PERMISSIONS.prebook)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async releaseHold(@Param('holdId') holdId: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    return this.inventoryHolds.releaseOwn(tenantId, holdId, identity.user.id, req.requestId ?? randomUUID())
  }

  @Post('rates/recheck')
  @ApiOperation({ summary: 'Authoritatively recheck a canonical offer without allocating inventory' })
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async recheck(@Body() body: OfferRecheckDto, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request,
    @Res({ passthrough: true }) response: Response) {
    const tenantId = (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY]
    const result = await this.offerHolds.recheck({ offerId: body.offerId, searchId: body.searchId,
      expectedCurrency: body.expectedCurrency, expectedSellAmountMinor: body.expectedSellAmountMinor,
      tenantId, user: identity, requestId: req.requestId ?? randomUUID() })
    const statusCodes = { rechecked: HttpStatus.OK, held: HttpStatus.OK, unavailable: HttpStatus.CONFLICT,
      price_changed: HttpStatus.CONFLICT, offer_expired: HttpStatus.GONE, mapping_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
      provider_unavailable: HttpStatus.SERVICE_UNAVAILABLE, rejected: HttpStatus.BAD_REQUEST } as const
    response.status(statusCodes[result.status])
    return result
  }

  @Post('prebook')
  @ApiOperation({ summary: 'Claim a held offer, reserve wallet credit and prebook it (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.prebook)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async prebook(@Body() body: PrebookBookingDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) {
      await this.audit.record({ tenantId, user: identity, action: 'booking.prebook.unavailable', entityType: 'inventory_hold', entityId: body.inventoryHoldId, payload: { reason: 'booking_disabled' } })
      response.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'booking_unavailable', message: 'Booking is unavailable until supplier, recheck and finance gates are certified.' }
    }
    const result = await this.bookingTx.prebook({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), inventoryHoldId: body.inventoryHoldId, idempotencyKey: body.idempotencyKey,
      adults: body.adults, children: body.children, childAges: body.childAges, leadGuest: body.leadGuest })
    response.status(HttpStatus.CREATED)
    return result
  }

  @Post('bookings')
  @ApiOperation({ summary: 'Confirm a prebooked booking atomically: inventory sold, wallet debited (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.createBooking)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async createBooking(@Body() body: ConfirmBookingDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) {
      await this.audit.record({ tenantId, user: identity, action: 'booking.create.unavailable', entityType: 'booking', entityId: body.bookingId, payload: { reason: 'booking_disabled' } })
      response.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'booking_unavailable', message: 'Booking is unavailable until supplier, recheck, persistence and finance gates are certified.' }
    }
    const result = await this.bookingTx.confirm({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId: body.bookingId })
    response.status(result.alreadyConfirmed ? HttpStatus.OK : HttpStatus.CREATED)
    return result
  }

  @Get('bookings')
  @ApiOperation({ summary: 'List the tenant\'s bookings, newest first (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async listBookings(@Query('limit') limit: string | undefined, @ActiveTenant() tenantId: string, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Bookings are unavailable until booking gates are certified.' } }
    return this.bookingQueries.list(tenantId, Number(limit) || 50)
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'Booking detail with issued documents and whether it can still be cancelled (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async bookingDetail(@Param('id') bookingId: string, @ActiveTenant() tenantId: string, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Bookings are unavailable until booking gates are certified.' } }
    return this.bookingQueries.detail(tenantId, bookingId)
  }

  @Get('bookings/:id/cancellation-quote')
  @ApiOperation({ summary: 'Quote the penalty and refund for cancelling a confirmed booking now (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.cancelBooking)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async cancellationQuote(@Param('id') bookingId: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Cancellation is unavailable until booking gates are certified.' } }
    return this.cancellations.quote({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId })
  }

  @Get('bookings/:id/documents/:type')
  @ApiOperation({ summary: 'Issue (once) or return an immutable booking document: voucher, invoice or credit-note (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async bookingDocument(@Param('id') bookingId: string, @Param('type') type: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Booking documents are unavailable until booking gates are certified.' } }
    return this.documents.get({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId, type: documentKindFromRoute(type) })
  }

  @Get('bookings/:id/documents/:type/html')
  @ApiOperation({ summary: 'Printable HTML of an immutable booking document (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async bookingDocumentHtml(@Param('id') bookingId: string, @Param('type') type: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res() response: Response) {
    if (!bookingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE).type('text/plain').send('Booking documents are unavailable.'); return }
    const document = await this.documents.get({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId, type: documentKindFromRoute(type) })
    response.status(HttpStatus.OK).set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
      .send(renderBookingDocument({ type: document.type, number: document.number, issuedAt: document.issuedAt, bookingStatus: document.bookingStatus, payload: document.payload }))
  }

  @Delete('bookings/:id')
  @ApiOperation({ summary: 'Cancel a confirmed booking atomically: policy penalty, inventory returned, refund posted (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.cancelBooking)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async cancel(@Param('id') bookingId: string, @Body() body: CancellationDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) {
      await this.audit.record({ tenantId, user: identity, action: 'booking.cancel.unavailable', entityType: 'booking', entityId: bookingId, payload: { reason: 'booking_disabled' } })
      response.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'booking_unavailable', bookingId, message: 'Cancellation is unavailable until booking gates are certified.' }
    }
    return this.cancellations.cancel({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId, reason: body.reason })
  }

  @Post('bookings/reconcile-stale')
  @ApiOperation({ summary: 'Resolve interrupted booking attempts: return stale PROCESSING holds and unreleased wallet reservations' })
  @RequirePermission(PERMISSIONS.reconcileBookings)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  reconcileStale(@Body() body: ReconcileBookingsDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    return this.reconciliation.reconcileStale({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), staleMinutes: body.staleMinutes, prebookMaxMinutes: body.prebookMaxMinutes, dryRun: body.dryRun })
  }

  @Get('finance/summary')
  @RequirePermission(PERMISSIONS.viewFinance)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  finance(@ActiveTenant() tenantId: string) { return this.financeService.summary(tenantId) }

  @Get('audit')
  @RequirePermission(PERMISSIONS.auditRead)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  auditEvents(@ActiveTenant() tenantId: string, @Query('limit') limit?: string) { return this.audit.list(tenantId, Math.max(1, Math.trunc(Number(limit)) || 50)) }
}
