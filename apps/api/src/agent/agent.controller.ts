import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { AgentRbacGuard } from './rbac.guard'
import { TenantContextGuard } from './tenant-context.guard'
import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator'

class SearchHotelsDto {
  @IsString()
  destination!: string

  @IsDateString()
  checkIn!: string

  @IsDateString()
  checkOut!: string

  @IsInt()
  @Min(1)
  rooms!: number

  @IsInt()
  @Min(1)
  adults!: number

  @IsInt()
  @Min(0)
  children!: number

  @IsString()
  nationality!: string

  @IsOptional()
  @IsString()
  currency?: string
}

@ApiTags('agent')
@Controller('agent')
@UseGuards(SessionAuthGuard)
export class AgentController {
  @Get('context')
  @ApiOperation({ summary: 'Return the authenticated agent context and memberships' })
  context(@CurrentUser() identity: AuthenticatedUser) {
    return { user: identity.user, memberships: identity.memberships, capabilities: ['hotel.search', 'booking.read'] }
  }

  @Post('search')
  @UseGuards(TenantContextGuard, AgentRbacGuard)
  @ApiOperation({ summary: 'Search live hotel inventory through the configured supplier boundary' })
  search(@Body() criteria: SearchHotelsDto, @CurrentUser() identity: AuthenticatedUser) {
    return {
      request: { ...criteria, currency: criteria.currency ?? 'USD' },
      tenantIds: identity.memberships.map((membership) => membership.tenantId),
      status: 'provider_unavailable' as const,
      hotels: [],
      total: 0,
      message: 'No supplier adapter is configured for this environment. The request was authenticated and tenant-scoped.',
    }
  }

  @Get('finance/summary')
  @ApiOperation({ summary: 'Return the authenticated tenant finance capability status' })
  finance(@CurrentUser() identity: AuthenticatedUser) {
    return {
      tenantIds: identity.memberships.map((membership) => membership.tenantId),
      status: 'not_configured' as const,
      currency: 'USD',
      availableCredit: null,
      message: 'Credit and ledger data will be returned when the finance ledger is configured.',
    }
  }
}
