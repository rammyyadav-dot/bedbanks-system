import { BadRequestException, Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentAuditService } from './audit.service'
import { CancellationDto, RateActionDto } from './domain.dto'
import { AgentFinanceService } from './finance.service'
import { AgentRbacGuard, RequirePermission } from './rbac.guard'
import { SupplierAdapter, SUPPLIER_ADAPTER, HotelSearchCriteria, PERMISSIONS } from './supplier.port'
import { TenantContextGuard } from './tenant-context.guard'
import { IsArray, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator'
import { SUPPORTED_SETTLEMENT_CURRENCIES } from './currency'
import { validSearchCriteria, validateSearchHotels } from '@bedbanks/domain/search-offers'

class SearchHotelsDto implements HotelSearchCriteria {
  @IsString() destination!: string
  @IsDateString() checkIn!: string
  @IsDateString() checkOut!: string
  @IsInt() @Min(1) rooms!: number
  @IsInt() @Min(1) adults!: number
  @IsInt() @Min(0) children!: number
  @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) @Max(17, { each: true }) childAges!: number[]
  @IsString() nationality!: string
  @IsOptional() @IsIn(SUPPORTED_SETTLEMENT_CURRENCIES) currency = 'USD'
}

@ApiTags('agent')
@Controller('agent')
@UseGuards(SessionAuthGuard)
export class AgentController {
  constructor(
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
    private readonly financeService: AgentFinanceService,
    private readonly audit: AgentAuditService,
  ) {}

  @Get('context')
  @ApiOperation({ summary: 'Return authenticated agent context and memberships' })
  context(@CurrentUser() identity: AuthenticatedUser) {
    return { user: identity.user, memberships: identity.memberships, capabilities: Object.values(PERMISSIONS) }
  }

  @Post('search/status')
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async searchStatus(@Body() criteria: SearchHotelsDto) {
    if (!validSearchCriteria(criteria)) throw new BadRequestException('Invalid search criteria')
    return { status: this.supplier.name === 'unconfigured' ? 'provider_unavailable' : 'available' }
  }

  @Post('search')
  @ApiOperation({ summary: 'Version 1 canonical hotel, room and rate offers; booking stays unavailable' })
  @RequirePermission(PERMISSIONS.search)
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async search(@Body() criteria: SearchHotelsDto, @CurrentUser() identity: AuthenticatedUser, @Headers('x-fbeds-tenant-id') tenantId: string) {
    if (!validSearchCriteria(criteria)) throw new BadRequestException('Invalid search criteria')
    const request = {
      destination: criteria.destination, checkIn: criteria.checkIn, checkOut: criteria.checkOut,
      rooms: criteria.rooms, adults: criteria.adults, children: criteria.children,
      childAges: criteria.childAges, nationality: criteria.nationality, currency: criteria.currency,
    }
    if (this.supplier.name === 'unconfigured')
      return { version: 1, request, status: 'provider_unavailable', hotels: [], total: 0 }
    let raw: unknown
    try {
      raw = await this.supplier.search(request)
    } catch {
      return { version: 1, request, status: 'provider_unavailable', hotels: [], total: 0 }
    }
    const result = validateSearchHotels(raw, request)
    if (!result.ok) {
      await this.audit.record({ tenantId, user: identity, action: 'hotel.search.mapping_unavailable',
        entityType: 'search', entityId: tenantId, payload: { destination: criteria.destination } })
      return { version: 1, request, status: 'mapping_unavailable', hotels: [], total: 0 }
    }
    await this.audit.record({ tenantId, user: identity, action: 'hotel.search', entityType: 'search', entityId: tenantId,
      payload: { destination: criteria.destination, supplier: this.supplier.name, resultCount: result.hotels.length } })
    return { version: 1, request, status: result.hotels.length ? 'available' : 'no_availability',
      hotels: result.hotels, total: result.hotels.length }
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
