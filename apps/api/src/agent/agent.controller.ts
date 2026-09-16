import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentAuditService } from './audit.service'
import { CancellationDto, RateActionDto } from './domain.dto'
import { AgentFinanceService } from './finance.service'
import { AgentRbacGuard } from './rbac.guard'
import { SupplierAdapter, SUPPLIER_ADAPTER, HotelSearchCriteria, priceRate, PERMISSIONS } from './supplier.port'
import { TenantContextGuard } from './tenant-context.guard'
import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator'

class SearchHotelsDto implements HotelSearchCriteria {
  @IsString() destination!: string
  @IsDateString() checkIn!: string
  @IsDateString() checkOut!: string
  @IsInt() @Min(1) rooms!: number
  @IsInt() @Min(1) adults!: number
  @IsInt() @Min(0) children!: number
  @IsString() nationality!: string
  @IsOptional() @IsString() currency = 'USD'
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
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async searchStatus(@Body() criteria: SearchHotelsDto) {
    const hotels = await this.supplier.search({ ...criteria, currency: criteria.currency ?? 'USD' })
    return { status: hotels.length ? 'available' as const : 'provider_unavailable' as const, supplier: this.supplier.name }
  }

  @Post('search')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async search(@Body() criteria: SearchHotelsDto, @CurrentUser() identity: AuthenticatedUser, @Headers('x-fbeds-tenant-id') tenantId: string) {
    const hotels = await this.supplier.search({ ...criteria, currency: criteria.currency ?? 'USD' })
    await this.audit.record({ tenantId, user: identity, action: 'hotel.search', entityType: 'search', entityId: tenantId, payload: { destination: criteria.destination, supplier: this.supplier.name, resultCount: hotels.length } })
    return { request: { ...criteria, currency: criteria.currency ?? 'USD' }, tenantId, status: hotels.length ? 'available' : 'provider_unavailable', hotels, total: hotels.length, supplier: this.supplier.name }
  }

  @Post('rates/recheck')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async recheck(@Body() body: RateActionDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    const rate = await this.supplier.recheck({ hotelId: body.hotelId, rateId: body.rateId, criteria: {} as HotelSearchCriteria })
    const quote = priceRate(rate)
    await this.audit.record({ tenantId, user: identity, action: 'rate.recheck', entityType: 'rate', entityId: body.rateId, payload: { quote } })
    return { status: 'rechecked', ...quote, rate }
  }

  @Post('prebook')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async prebook(@Body() body: RateActionDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    const result = await this.supplier.prebook({ hotelId: body.hotelId, rateId: body.rateId, criteria: {} as HotelSearchCriteria, idempotencyKey: body.idempotencyKey })
    await this.financeService.assertFunds(tenantId, result.rate.totalMinor)
    await this.audit.record({ tenantId, user: identity, action: 'booking.prebook', entityType: 'rate', entityId: body.rateId, payload: { supplierReference: result.supplierReference } })
    return { status: 'prebooked', supplier: this.supplier.name, ...result, quote: priceRate(result.rate) }
  }

  @Post('bookings')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async createBooking(@Body() body: RateActionDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    const result = await this.supplier.prebook({ hotelId: body.hotelId, rateId: body.rateId, criteria: {} as HotelSearchCriteria, idempotencyKey: body.idempotencyKey })
    await this.financeService.assertFunds(tenantId, result.rate.totalMinor)
    await this.audit.record({ tenantId, user: identity, action: 'booking.create.requested', entityType: 'booking', entityId: body.idempotencyKey, payload: { hotelId: body.hotelId, rateId: body.rateId, totalMinor: result.rate.totalMinor } })
    return { status: 'provider_unavailable', message: 'Booking persistence is ready, but no live supplier is configured.', supplier: this.supplier.name }
  }

  @Delete('bookings/:id')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  async cancel(@Param('id') bookingId: string, @Body() body: CancellationDto, @Headers('x-fbeds-tenant-id') tenantId: string, @CurrentUser() identity: AuthenticatedUser) {
    await this.audit.record({ tenantId, user: identity, action: 'booking.cancel.requested', entityType: 'booking', entityId: bookingId, payload: { reason: body.reason } })
    return { status: 'provider_unavailable', bookingId, message: 'Cancellation is ready for a supplier adapter but none is configured.' }
  }

  @Get('finance/summary')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  finance(@Headers('x-fbeds-tenant-id') tenantId: string) { return this.financeService.summary(tenantId) }

  @Get('audit')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  auditEvents(@Headers('x-fbeds-tenant-id') tenantId: string, @Query('limit') limit?: string) { return this.audit.list(tenantId, Number(limit) || 50) }
}
