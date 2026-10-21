import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { ActiveTenant, TenantContextGuard } from '../agent/tenant-context.guard'
import { AgentRbacGuard, RequirePermission } from '../agent/rbac.guard'
import { PERMISSIONS } from '../agent/supplier.port'
import { BookingFinancePostingBacklogService } from './booking-finance-posting-backlog.service'
import { BookingRevenueService } from './booking-revenue.service'

/** The backlog of the booking Finance consumer (ADR 0076). Read-only; needs finance.read. Tenant identity comes from the session only. */
@ApiTags('admin-booking-finance-postings')
@Controller('admin/finance/booking-postings')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class BookingFinancePostingController {
  constructor(private readonly backlog: BookingFinancePostingBacklogService, private readonly revenue: BookingRevenueService) {}

  @Get() @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  view(@ActiveTenant() tenantId: string) { return this.backlog.backlog(tenantId) }

  // Declared after the backlog route; a different static path, so there is no clash.
  @Get('revenue') @RequirePermission(PERMISSIONS.viewFinance) @UseGuards(AgentRbacGuard)
  revenueReport(@ActiveTenant() tenantId: string, @Query() query: Record<string, unknown>) { return this.revenue.report(tenantId, query) }
}
