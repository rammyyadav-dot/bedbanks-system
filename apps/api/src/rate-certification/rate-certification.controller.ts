import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { RateCertificationService } from './rate-certification.service'

type Q = Record<string, unknown>

/**
 * Read-only rate plan audit (ADR 0033). Tenant identity comes from the session; every handler needs the existing `supply.rates.read`
 * permission, held through a formal role. POST /simulate is a read: it prices a stay and writes nothing, so it needs no idempotency key.
 */
@ApiTags('admin-rate-certification')
@Controller('admin/rate-certification')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class RateCertificationController {
  constructor(private readonly service: RateCertificationService) {}

  @Get('summary') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  summary(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.service.summary(tenantId, query) }

  @Get('plans') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  plans(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.service.plans(tenantId, query) }

  @Get('plans/:ratePlanId') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  plan(@ActiveTenant() tenantId: string, @Param('ratePlanId') ratePlanId: string, @Query() query: Q) { return this.service.plan(tenantId, ratePlanId, query) }

  @Get('hotels') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  hotels(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.service.hotels(tenantId, query) }

  @Get('markup-rules') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  markupRules(@ActiveTenant() tenantId: string) { return this.service.markupRules(tenantId) }

  @Get('remediation') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  remediation(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.service.remediation(tenantId, query) }

  @Get('report') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  report(@ActiveTenant() tenantId: string, @Query() query: Q) { return this.service.report(tenantId, query) }

  @Post('simulate') @HttpCode(200) @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  simulate(@ActiveTenant() tenantId: string, @Body() body: unknown) { return this.service.simulate(tenantId, body) }
}
