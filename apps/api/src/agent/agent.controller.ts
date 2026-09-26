import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpStatus, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentAuditService } from './audit.service'
import { CancellationDto, OfferHoldDto, OfferHoldParamsDto, RateActionDto } from './domain.dto'
import { AgentFinanceService } from './finance.service'
import { AgentRbacGuard, RequirePermission } from './rbac.guard'
import { SupplierAdapter, SUPPLIER_ADAPTER, HotelSearchCriteria, PERMISSIONS } from './supplier.port'
import { ACTIVE_TENANT_REQUEST_KEY, TenantContextGuard } from './tenant-context.guard'
import { IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { SUPPORTED_SETTLEMENT_CURRENCIES } from './currency'
import { validSearchCriteria, validateSearchHotels } from '@bedbanks/domain/search-offers'
import { OfferHoldService } from './offer-hold.service'

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
  ) {}

  @Get('context')
  @ApiOperation({ summary: 'Return authenticated agent context and memberships' })
  context(@CurrentUser() identity: AuthenticatedUser) {
    return { user: identity.user, memberships: identity.memberships, capabilities: Object.values(PERMISSIONS) }
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
    const statusCodes = { held: HttpStatus.CREATED, unavailable: HttpStatus.CONFLICT, price_changed: HttpStatus.CONFLICT,
      offer_expired: HttpStatus.GONE, mapping_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
      provider_unavailable: HttpStatus.SERVICE_UNAVAILABLE, rejected: HttpStatus.BAD_REQUEST } as const
    response.status(statusCodes[result.status])
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
    const requestId = req.requestId ?? randomUUID()
    const searchId = randomUUID()
    const generatedAt = new Date().toISOString()
    const request = {
      destination: criteria.destination, checkIn: criteria.checkIn, checkOut: criteria.checkOut,
      rooms: criteria.rooms, adults: criteria.adults, children: criteria.children,
      childAges: criteria.childAges, nationality: criteria.nationality, currency: criteria.currency,
      ...(criteria.canonicalHotelIds ? { canonicalHotelIds: criteria.canonicalHotelIds } : {}),
      ...(criteria.limit ? { limit: criteria.limit } : {}), ...(criteria.filters ? { filters: criteria.filters } : {}),
    }
    if (this.supplier.name === 'unconfigured')
      return { version: 1, searchId, requestId, generatedAt, request, status: 'provider_unavailable', hotels: [], total: 0,
        providerSummary: { queried: 0, succeeded: 0, failed: 0 } }
    let raw: Awaited<ReturnType<SupplierAdapter['search']>>
    try {
      raw = await this.supplier.search(request, { tenantId, requestId })
    } catch {
      return { version: 1, searchId, requestId, generatedAt, request, status: 'provider_unavailable', hotels: [], total: 0,
        providerSummary: { queried: 1, succeeded: 0, failed: 1 } }
    }
    const summary = raw.providerSummary
    const validSummary = summary && Number.isSafeInteger(summary.queried) && Number.isSafeInteger(summary.succeeded) &&
      Number.isSafeInteger(summary.failed) && summary.queried >= 0 && summary.succeeded >= 0 && summary.failed >= 0 &&
      summary.succeeded + summary.failed <= summary.queried
    const result = validSummary ? validateSearchHotels(raw.offers, request, Date.now(), tenantId) : { ok: false as const, reason: 'mapping_unavailable' as const }
    if (!result.ok) {
      await this.audit.record({ tenantId, user: identity, action: 'hotel.search.mapping_unavailable',
        entityType: 'search', entityId: searchId, payload: { destination: criteria.destination, requestId } })
      return { version: 1, searchId, requestId, generatedAt, request, status: 'mapping_unavailable', hotels: [], total: 0,
        providerSummary: validSummary ? summary : { queried: 1, succeeded: 0, failed: 1 } }
    }
    const status = result.hotels.length
      ? raw.providerSummary.failed > 0 ? 'partial' : 'available'
      : raw.providerSummary.failed > 0 && raw.providerSummary.succeeded === 0 ? 'provider_unavailable' : 'no_availability'
    await this.audit.record({ tenantId, user: identity, action: 'hotel.search', entityType: 'search', entityId: searchId,
      payload: { destination: criteria.destination, supplier: this.supplier.name, resultCount: result.hotels.length, requestId, status } })
    return { version: 1, searchId, requestId, generatedAt, request, status,
      hotels: result.hotels, total: result.hotels.length, providerSummary: raw.providerSummary }
  }

  @Post('rates/recheck')
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async recheck(@Body() body: RateActionDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    // A rateId plus display strings cannot prove the selected room, board,
    // policy and amount belong to the same supplier offer.
    await this.audit.record({ tenantId, user: identity, action: 'rate.recheck.unavailable', entityType: 'rate', entityId: body.rateId, payload: { reason: 'offer_contract_incomplete' } })
    return { status: 'provider_unavailable', message: 'Authoritative rate recheck is unavailable.' }
  }

  @Post('prebook')
  @RequirePermission(PERMISSIONS.prebook)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async prebook(@Body() body: RateActionDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    await this.audit.record({ tenantId, user: identity, action: 'booking.prebook.unavailable', entityType: 'rate', entityId: body.rateId, payload: { reason: 'transactional_gates_incomplete' } })
    return { status: 'booking_unavailable', message: 'Booking is unavailable until supplier, recheck and finance gates are certified.' }
  }

  @Post('bookings')
  @RequirePermission(PERMISSIONS.createBooking)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async createBooking(@Body() body: RateActionDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    await this.audit.record({ tenantId, user: identity, action: 'booking.create.unavailable', entityType: 'booking', entityId: body.idempotencyKey, payload: { reason: 'transactional_gates_incomplete' } })
    return { status: 'booking_unavailable', message: 'Booking is unavailable until supplier, recheck, persistence and finance gates are certified.' }
  }

  @Delete('bookings/:id')
  @RequirePermission(PERMISSIONS.cancelBooking)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async cancel(@Param('id') bookingId: string, @Body() body: CancellationDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    await this.audit.record({ tenantId, user: identity, action: 'booking.cancel.requested', entityType: 'booking', entityId: bookingId, payload: { reason: body.reason } })
    return { status: 'provider_unavailable', bookingId, message: 'Cancellation is ready for a supplier adapter but none is configured.' }
  }

  @Get('finance/summary')
  @RequirePermission(PERMISSIONS.viewFinance)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  finance(@Headers('x-fbeds-tenant-id') tenantId: string) { return this.financeService.summary(tenantId) }

  @Get('audit')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  auditEvents(@Headers('x-fbeds-tenant-id') tenantId: string, @Query('limit') limit?: string) { return this.audit.list(tenantId, Number(limit) || 50) }
}
