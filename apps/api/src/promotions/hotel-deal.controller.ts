import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import type { HotelDealDecisionInput, HotelDealPreviewInput, HotelDealSubmitInput, HotelDealTransitionInput } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ACTIVE_TENANT_REQUEST_KEY, TenantContextGuard } from '../agent/tenant-context.guard'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { HotelDealService } from './hotel-deal.service'

type Q = Record<string, unknown>

/**
 * Hotel deals and promotions (ADR 0089). Tenant identity comes from the session. Reads need supply.rates.read; every change needs supply.rates.manage.
 * Approving and activating are separate calls: the approval service refuses the maker deciding their own request, and activation needs an APPROVED request
 * bound to exactly the terms reviewed. Static routes are declared before `:dealId` so they are never read as an id.
 */
@ApiTags('admin-commercial')
@Controller('admin/commercial/promotions')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class HotelDealController {
  constructor(private readonly deals: HotelDealService) {}

  private context(req: Request) {
    const identity = (req as unknown as { user: AuthenticatedUser }).user
    return { tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY], userId: identity.user.id, requestId: (req as unknown as { requestId?: string }).requestId }
  }

  @Get() @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  list(@Req() req: Request, @Query() query: Q) { return this.deals.list(this.context(req).tenantId, query) }

  @Get('summary') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  summary(@Req() req: Request, @Query() query: Q) { return this.deals.summary(this.context(req).tenantId, query) }

  @Get('approval-queue') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  approvalQueue(@Req() req: Request) { const c = this.context(req); return this.deals.approvalQueue(c.tenantId, c.userId) }

  @Post() @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  create(@Req() req: Request, @Body() body: unknown) { const c = this.context(req); return this.deals.create(c.tenantId, c.userId, body, c.requestId) }

  @Post('reconcile') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  reconcile(@Req() req: Request) { const c = this.context(req); return this.deals.reconcile(c.tenantId, c.userId, c.requestId) }

  @Post('approvals/:approvalId/approve') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  approve(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: HotelDealDecisionInput) { const c = this.context(req); return this.deals.decide(c.tenantId, c.userId, approvalId, 'APPROVED', body, c.requestId) }

  @Post('approvals/:approvalId/reject') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  reject(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: HotelDealDecisionInput) { const c = this.context(req); return this.deals.decide(c.tenantId, c.userId, approvalId, 'REJECTED', body, c.requestId) }

  @Post('approvals/:approvalId/execute') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  execute(@Req() req: Request, @Param('approvalId') approvalId: string) { const c = this.context(req); return this.deals.execute(c.tenantId, c.userId, approvalId, c.requestId) }

  @Get(':dealId') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  get(@Req() req: Request, @Param('dealId') dealId: string) { const c = this.context(req); return this.deals.get(c.tenantId, c.userId, dealId) }

  @Put(':dealId') @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  replace(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: unknown) { const c = this.context(req); return this.deals.replace(c.tenantId, c.userId, dealId, body, c.requestId) }

  @Post(':dealId/validate') @HttpCode(200) @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  validate(@Req() req: Request, @Param('dealId') dealId: string) { return this.deals.validate(this.context(req).tenantId, dealId) }

  @Post(':dealId/preview') @HttpCode(200) @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  preview(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: HotelDealPreviewInput) { return this.deals.preview(this.context(req).tenantId, dealId, body) }

  @Post(':dealId/submit') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  submit(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: HotelDealSubmitInput) { const c = this.context(req); return this.deals.submit(c.tenantId, c.userId, dealId, body, c.requestId) }

  @Post(':dealId/withdraw') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  withdraw(@Req() req: Request, @Param('dealId') dealId: string) { const c = this.context(req); return this.deals.withdraw(c.tenantId, c.userId, dealId, c.requestId) }

  @Post(':dealId/pause') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  pause(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: HotelDealTransitionInput) { const c = this.context(req); return this.deals.transition(c.tenantId, c.userId, dealId, 'pause', body, c.requestId) }

  @Post(':dealId/resume') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  resume(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: HotelDealTransitionInput) { const c = this.context(req); return this.deals.transition(c.tenantId, c.userId, dealId, 'resume', body, c.requestId) }

  @Post(':dealId/suspend') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  suspend(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: HotelDealTransitionInput) { const c = this.context(req); return this.deals.transition(c.tenantId, c.userId, dealId, 'suspend', body, c.requestId) }

  @Post(':dealId/return-to-draft') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  returnToDraft(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: HotelDealTransitionInput) { const c = this.context(req); return this.deals.transition(c.tenantId, c.userId, dealId, 'return-to-draft', body, c.requestId) }

  @Post(':dealId/archive') @HttpCode(200) @RequireSupplyPermission('supply.rates.manage') @UseGuards(SupplyPermissionGuard)
  archive(@Req() req: Request, @Param('dealId') dealId: string, @Body() body: HotelDealTransitionInput) { const c = this.context(req); return this.deals.transition(c.tenantId, c.userId, dealId, 'archive', body, c.requestId) }

  @Get(':dealId/audit-log') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  auditLog(@Req() req: Request, @Param('dealId') dealId: string) { return this.deals.auditTrail(this.context(req).tenantId, dealId) }

  @Get(':dealId/performance') @RequireSupplyPermission('supply.rates.read') @UseGuards(SupplyPermissionGuard)
  performance(@Req() req: Request, @Param('dealId') dealId: string) { return this.deals.performance(this.context(req).tenantId, dealId) }
}
