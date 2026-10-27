import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpStatus, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { PrismaService } from '../database/prisma.service'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentAuditService } from './audit.service'
import { CancellationDto, OfferHoldDto, OfferHoldParamsDto, OfferRecheckDto, ReconcileBookingsDto, PrebookBookingDto, ConfirmBookingDto } from './domain.dto'
import { normalizeCcEmails, validRecipient } from './checkout-details'
import { AgentFinanceService } from './finance.service'
import { AgencySuspensionGuard, AllowWhenAgencySuspended } from './agency-suspension.guard'
import { AgentHotelImageService } from './agent-hotel-image.service'
import { AgentRbacGuard, RequirePermission } from './rbac.guard'
import { SupplierAdapter, SUPPLIER_ADAPTER, PERMISSIONS } from './supplier.port'
import type { SearchCriteria } from '@bedbanks/domain'
import { ACTIVE_TENANT_HEADER, ActiveTenant, TenantContextGuard, activeTenantId, sessionTenantId } from './tenant-context.guard'
import { effectiveAgentPermissions } from './agent-permissions'
import type { AgentPermission } from './supplier.port'
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { defaultSettlementCurrency, enabledSettlementCurrencies } from './currency'
import { projectAgentHotels, validSearchCriteria } from './search-offers'
import { OfferHoldService } from './offer-hold.service'
import { AgentSearchService } from './agent-search.service'
import { DestinationResolverService } from './destination-resolver.service'
import { SmartSearchService } from './smart-search.service'
import { DUPLICATE_BOOKING_SUSPECTED, SMART_SEARCH_TEXT_MAX } from '@bedbanks/contracts'
import { BookingReconciliationService } from './booking-reconciliation.service'
import { BookingTransactionService, bookingEnabled, bookingServicingEnabled } from './booking-transaction.service'
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
  @IsOptional() @IsArray() @IsString({ each: true }) propertyTypes?: string[]
  @IsOptional() @IsArray() @IsString({ each: true }) brands?: string[]
}

class DestinationRefDto {
  @IsIn(['city', 'hotel']) type!: 'city' | 'hotel'
  @IsString() id!: string
  @IsOptional() @IsString() countryCode?: string
}

class RoomChildDto {
  @IsInt() @Min(0) @Max(17) age!: number
}

class RoomStayDto {
  @IsInt() @Min(1) @Max(8) adults!: number
  @IsArray() @ValidateNested({ each: true }) @Type(() => RoomChildDto) children: RoomChildDto[] = []
}

class SmartSearchParseDto {
  @IsString() @MinLength(1) @MaxLength(SMART_SEARCH_TEXT_MAX) text!: string
}

class SearchHotelsDto {
  @IsString() destination!: string
  @IsOptional() @IsArray() @IsString({ each: true }) canonicalHotelIds?: string[]
  @IsDateString() checkIn!: string
  @IsDateString() checkOut!: string
  @IsInt() @Min(1) rooms!: number
  @IsInt() @Min(1) adults!: number
  @IsInt() @Min(0) children!: number
  @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(17, { each: true }) childAges!: number[]
  @IsString() nationality!: string
  @IsOptional() @IsIn(enabledSettlementCurrencies() as unknown as string[]) currency: string = defaultSettlementCurrency()
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number
  @IsOptional() @IsInt() @Min(0) @Max(10000) offset?: number
  @IsOptional() @IsIn(['default', 'price', 'stars', 'name']) sort?: 'default' | 'price' | 'stars' | 'name'
  @IsOptional() @ValidateNested() @Type(() => DestinationRefDto) destinationRef?: DestinationRefDto
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => RoomStayDto) roomStays?: RoomStayDto[]
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
    private readonly destinationResolver: DestinationResolverService,
    private readonly prisma: PrismaService,
    private readonly hotelImages: AgentHotelImageService,
  ) {}

  @Get('destinations')
  @ApiOperation({ summary: 'Resolve a canonical city or hotel. Free text is not a destination.' })
  @RequirePermission(PERMISSIONS.search)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async listDestinations(@Query('q') query: string | undefined, @ActiveTenant() tenantId: string) {
    return { results: await this.destinationResolver.search(tenantId, typeof query === 'string' ? query : '') }
  }

  @Get('hotels/:hotelId/images/:imageId/content')
  @ApiOperation({ summary: 'Image of a published hotel (ADR 0027)' })
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async hotelImage(@ActiveTenant() tenantId: string, @Param('hotelId') hotelId: string, @Param('imageId') imageId: string, @Res() res: Response) {
    const file = await this.hotelImages.content(tenantId, hotelId, imageId)
    res.set({
      'Content-Type': file.contentType, 'Content-Length': String(file.data.length), ETag: `"${file.sha256}"`,
      'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    })
    res.status(200).end(file.data)
  }

  @Get('search-facets')
  @ApiOperation({ summary: 'Board and property-type values stored for this tenant' })
  @RequirePermission(PERMISSIONS.search)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async searchFacets(@ActiveTenant() tenantId: string) {
    return this.destinationResolver.facets(tenantId)
  }

  @Get('context')
  @ApiOperation({ summary: 'Return authenticated agent context, memberships and effective grants for the selected tenant' })
  async context(@CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    const requested = req.headers[ACTIVE_TENANT_HEADER]
    if (requested === undefined || requested === '') {
      return { user: identity.user, memberships: identity.memberships, capabilities: [] as AgentPermission[], bookingEnabled: bookingEnabled(), settlementCurrencies: [...enabledSettlementCurrencies()] }
    }
    const tenantId = sessionTenantId(identity, requested)
    const capabilities = await this.effectiveCapabilities(identity.user.id, tenantId)
    return { user: identity.user, memberships: identity.memberships, capabilities, bookingEnabled: bookingEnabled(), settlementCurrencies: [...enabledSettlementCurrencies()] }
  }

  @Post('offers/:offerId/hold')
  @ApiOperation({ summary: 'Authoritatively recheck a canonical offer and create a non-bookable inventory hold' })
  @RequirePermission(PERMISSIONS.prebook)
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async holdOffer(@Param() params: OfferHoldParamsDto, @Body() body: OfferHoldDto,
    @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    const tenantId = activeTenantId(req)
    if (!bookingEnabled()) {
      await this.audit.record({ tenantId, user: identity, action: 'booking.hold.unavailable', entityType: 'offer', entityId: params.offerId, payload: { reason: 'booking_disabled' } })
      response.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'booking_unavailable', message: 'Booking is unavailable until supplier, recheck and finance gates are certified.' }
    }
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
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async searchStatus(@Body() criteria: SearchHotelsDto, @ActiveTenant() tenantId: string) {
    const resolved = await this.destinationResolver.apply(tenantId, criteria as SearchCriteria)
    if (!resolved || !validSearchCriteria(resolved)) throw new BadRequestException('Invalid search criteria')
    return { status: this.supplier.name === 'unconfigured' ? 'provider_unavailable' : 'not_checked' }
  }

  @Post('search/parse')
  @ApiOperation({ summary: 'Smart Search: read search fields from a pasted client request (ADR 0065). The text is not stored or logged.' })
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async parseSmartSearch(@Body() body: SmartSearchParseDto, @ActiveTenant() tenantId: string) {
    return new SmartSearchService(this.destinationResolver).parse(tenantId, body.text)
  }

  @Post('search')
  @ApiOperation({ summary: 'Version 1 canonical hotel, room and rate offers; booking stays unavailable' })
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async search(@Body() criteria: SearchHotelsDto, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    const tenantId = activeTenantId(req)
    const resolved = await this.destinationResolver.apply(tenantId, criteria as SearchCriteria)
    if (!resolved) throw new BadRequestException('Canonical destination is no longer available')
    if (!validSearchCriteria(resolved)) throw new BadRequestException('Invalid search criteria')
    const response = await this.agentSearch.execute(resolved, tenantId, req.requestId ?? randomUUID(), identity)
    // The buyer sees the sell price only: cost, margin and supply identity never leave the API (ADR 0075).
    return { ...response, hotels: projectAgentHotels(response.hotels) }
  }

  @Delete('holds/:holdId')
  @ApiOperation({ summary: 'Release your own un-booked inventory hold before it expires' })
  @RequirePermission(PERMISSIONS.prebook)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async releaseHold(@Param('holdId') holdId: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    return this.inventoryHolds.releaseOwn(tenantId, holdId, identity.user.id, req.requestId ?? randomUUID())
  }

  @Post('rates/recheck')
  @ApiOperation({ summary: 'Authoritatively recheck a canonical offer without allocating inventory' })
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async recheck(@Body() body: OfferRecheckDto, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request,
    @Res({ passthrough: true }) response: Response) {
    const tenantId = activeTenantId(req)
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
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async prebook(@Body() body: PrebookBookingDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) {
      await this.audit.record({ tenantId, user: identity, action: 'booking.prebook.unavailable', entityType: 'inventory_hold', entityId: body.inventoryHoldId, payload: { reason: 'booking_disabled' } })
      response.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'booking_unavailable', message: 'Booking is unavailable until supplier, recheck and finance gates are certified.' }
    }
    if (body.termsAccepted !== true) throw new BadRequestException({ code: 'TERMS_NOT_ACCEPTED', message: 'Accept the cancellation policy and booking terms to book.' })
    const requestId = req.requestId ?? randomUUID()
    // ADR 0066 amendment 1: a probable duplicate (same agency, hotel, dates and lead guest) needs the agent's explicit go-ahead. Nothing is held or charged yet.
    const duplicates = await this.bookingTx.findDuplicates({ tenantId, userId: identity.user.id, inventoryHoldId: body.inventoryHoldId, idempotencyKey: body.idempotencyKey, leadGuest: body.leadGuest })
    if (duplicates.length && body.acknowledgeDuplicate !== true) {
      throw new ConflictException({ code: DUPLICATE_BOOKING_SUSPECTED, message: `Your agency already has ${duplicates.length === 1 ? 'a booking' : 'bookings'} for this lead guest, hotel and dates (${duplicates.map((d) => d.reference).join(', ')}). Confirm that this is a separate booking.`, details: duplicates })
    }
    const result = await this.bookingTx.prebook({ tenantId, userId: identity.user.id, requestId, inventoryHoldId: body.inventoryHoldId, idempotencyKey: body.idempotencyKey,
      adults: body.adults, children: body.children, childAges: body.childAges, leadGuest: body.leadGuest,
      ...(body.guests ? { guests: body.guests } : {}), ...(body.agentRef !== undefined ? { agentRef: body.agentRef } : {}), ...(body.specialRequests ? { specialRequests: body.specialRequests } : {}) })
    // ADR 0066: the acceptance is evidence, so it is audited (no guest data).
    await this.audit.record({ tenantId, user: identity, action: 'booking.terms.accepted', entityType: 'booking', entityId: result.bookingId, payload: { requestId, inventoryHoldId: body.inventoryHoldId } })
    // The agent booked over a duplicate warning: evidence for support and finance (references only).
    if (duplicates.length) await this.audit.record({ tenantId, user: identity, action: 'booking.duplicate.acknowledged', entityType: 'booking', entityId: result.bookingId, payload: { requestId, existingReferences: duplicates.map((d) => d.reference) } })
    response.status(HttpStatus.CREATED)
    return result
  }

  @Post('bookings')
  @ApiOperation({ summary: 'Confirm a prebooked booking atomically: inventory sold, wallet debited (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.createBooking)
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async createBooking(@Body() body: ConfirmBookingDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingEnabled()) {
      await this.audit.record({ tenantId, user: identity, action: 'booking.create.unavailable', entityType: 'booking', entityId: body.bookingId, payload: { reason: 'booking_disabled' } })
      response.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'booking_unavailable', message: 'Booking is unavailable until supplier, recheck, persistence and finance gates are certified.' }
    }
    const requestId = req.requestId ?? randomUUID()
    const recipient = validRecipient(identity.user.email)
    const cc = normalizeCcEmails(body.ccEmails, recipient)
    const result = await this.bookingTx.confirm({ tenantId, userId: identity.user.id, requestId, bookingId: body.bookingId, recipient, cc: recipient ? cc : [] })
    // ADR 0066: voucher and invoice are issued right away (issue-once, immutable) so the confirmation page and the email can carry them.
    // A failure here does not undo a committed booking: the documents are issued on first open instead, and the null says so.
    const issue = async (type: 'VOUCHER' | 'INVOICE'): Promise<string | null> => {
      try { return (await this.documents.get({ tenantId, userId: identity.user.id, requestId, bookingId: result.bookingId, type })).number } catch { return null }
    }
    const [voucher, invoice] = await Promise.all([issue('VOUCHER'), issue('INVOICE')])
    response.status(result.alreadyConfirmed ? HttpStatus.OK : HttpStatus.CREATED)
    return { bookingId: result.bookingId, reference: result.reference, status: result.status, alreadyConfirmed: result.alreadyConfirmed, documents: { voucher, invoice },
      email: result.email ? { status: 'queued' as const, to: result.email.to, cc: result.email.cc } : { status: 'not_queued' as const, reason: 'no_recipient' as const } }
  }

  @Get('bookings')
  @ApiOperation({ summary: 'List the tenant\'s bookings, newest first (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async listBookings(@Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined, @Query('status') status: string | undefined, @ActiveTenant() tenantId: string, @Res({ passthrough: true }) response: Response) {
    if (!bookingServicingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Bookings are unavailable until booking gates are certified.' } }
    return this.bookingQueries.list(tenantId, { limit: Number(limit), offset: Number(offset), status: status || undefined })
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'Booking detail with issued documents and whether it can still be cancelled (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async bookingDetail(@Param('id') bookingId: string, @ActiveTenant() tenantId: string, @Res({ passthrough: true }) response: Response) {
    if (!bookingServicingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Bookings are unavailable until booking gates are certified.' } }
    return this.bookingQueries.detail(tenantId, bookingId)
  }

  @Get('bookings/:id/cancellation-quote')
  @ApiOperation({ summary: 'Quote the penalty and refund for cancelling a confirmed booking now (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.cancelBooking)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async cancellationQuote(@Param('id') bookingId: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingServicingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Cancellation is unavailable until booking gates are certified.' } }
    return this.cancellations.quote({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId })
  }

  @Get('bookings/:id/documents/:type')
  @ApiOperation({ summary: 'Issue (once) or return an immutable booking document: voucher, invoice or credit-note (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async bookingDocument(@Param('id') bookingId: string, @Param('type') type: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingServicingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE); return { status: 'booking_unavailable', message: 'Booking documents are unavailable until booking gates are certified.' } }
    return this.documents.get({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId, type: documentKindFromRoute(type) })
  }

  @Get('bookings/:id/documents/:type/html')
  @ApiOperation({ summary: 'Printable HTML of an immutable booking document (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.viewBookings)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async bookingDocumentHtml(@Param('id') bookingId: string, @Param('type') type: string, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res() response: Response) {
    if (!bookingServicingEnabled()) { response.status(HttpStatus.SERVICE_UNAVAILABLE).type('text/plain').send('Booking documents are unavailable.'); return }
    const document = await this.documents.get({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId, type: documentKindFromRoute(type) })
    response.status(HttpStatus.OK).set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
      .send(renderBookingDocument({ type: document.type, number: document.number, issuedAt: document.issuedAt, bookingStatus: document.bookingStatus, payload: document.payload }))
  }

  @Delete('bookings/:id')
  @ApiOperation({ summary: 'Cancel a confirmed booking atomically: policy penalty, inventory returned, refund posted (requires BOOKING_ENABLED=true)' })
  @RequirePermission(PERMISSIONS.cancelBooking)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  async cancel(@Param('id') bookingId: string, @Body() body: CancellationDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    if (!bookingServicingEnabled()) {
      await this.audit.record({ tenantId, user: identity, action: 'booking.cancel.unavailable', entityType: 'booking', entityId: bookingId, payload: { reason: 'booking_disabled' } })
      response.status(HttpStatus.SERVICE_UNAVAILABLE)
      return { status: 'booking_unavailable', bookingId, message: 'Cancellation is unavailable until booking gates are certified.' }
    }
    return this.cancellations.cancel({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), bookingId, reason: body.reason })
  }

  @Post('bookings/reconcile-stale')
  @ApiOperation({ summary: 'Resolve interrupted booking attempts: return stale PROCESSING holds and unreleased wallet reservations' })
  @RequirePermission(PERMISSIONS.reconcileBookings)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  reconcileStale(@Body() body: ReconcileBookingsDto, @ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser, @Req() req: Request) {
    return this.reconciliation.reconcileStale({ tenantId, userId: identity.user.id, requestId: req.requestId ?? randomUUID(), staleMinutes: body.staleMinutes, prebookMaxMinutes: body.prebookMaxMinutes, dryRun: body.dryRun })
  }

  @Get('finance/summary')
  @RequirePermission(PERMISSIONS.viewFinance)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  finance(@ActiveTenant() tenantId: string, @CurrentUser() identity: AuthenticatedUser) { return this.financeService.summary(tenantId, identity.user.id) }

  @Get('audit')
  @RequirePermission(PERMISSIONS.auditRead)
  @AllowWhenAgencySuspended()
  @UseGuards(TenantContextGuard, AgentRbacGuard, AgencySuspensionGuard)
  auditEvents(@ActiveTenant() tenantId: string, @Query('limit') limit?: string) { return this.audit.list(tenantId, Math.max(1, Math.trunc(Number(limit)) || 50)) }

  /** Same membership and role rows the RBAC guard uses. Returns nothing for a missing or inactive membership. */
  private async effectiveCapabilities(userId: string, tenantId: string): Promise<AgentPermission[]> {
    const membership = await this.prisma.withTenant(tenantId, (tx) => tx.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      include: { tenant: true },
    }))
    if (!membership || membership.tenantId !== tenantId || membership.tenant.status !== 'ACTIVE') {
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({
        data: { tenantId, actorType: 'USER', action: 'tenant.access.denied', entityType: 'tenant', entityId: tenantId, payload: { reason: 'inactive_or_missing_membership' }, userId },
      })).catch(() => undefined)
      throw new ForbiddenException('Access denied')
    }
    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({
      where: { userId, tenantId, role: { tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    }))
    const formal = roles.flatMap((item) => item.role.permissions.map((permission) => permission.permission.key))
    return effectiveAgentPermissions(membership.role, formal)
  }
}
