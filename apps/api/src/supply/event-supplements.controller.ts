import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import type { EventSupplementActivationRequestInput, EventSupplementAmendmentRequestInput, EventSupplementApprovalDecisionInput, EventSupplementApprovalExecuteInput, EventSupplementPreviewRequest, EventSupplementSuspendInput, EventSupplementWrite } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { TenantContextGuard, ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { EventSupplementsService } from './event-supplements.service'

/** Routes live in @bedbanks/contracts (supplyRoutes.eventSupplement*). Tenant and user come only from the session (CLAUDE.md invariant 1);
 * every handler declares the permission its service method enforces (invariant 2). */
@Controller('admin')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class EventSupplementsController {
  constructor(private readonly eventSupplements: EventSupplementsService) {}
  private context(req: Request) {
    const user = (req as unknown as { user: AuthenticatedUser }).user
    return { tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY], userId: user.user.id, requestId: (req as unknown as { requestId?: string }).requestId ?? req.header('x-request-id') ?? undefined }
  }

  @Get('event-supplements') @RequireSupplyPermission('supply.event_supplements.read') @UseGuards(SupplyPermissionGuard)
  list(@Req() req: Request, @Query() query: Record<string, unknown>) { const c = this.context(req); return this.eventSupplements.list(c.tenantId, query) }

  @Get('event-supplements/:eventSupplementId') @RequireSupplyPermission('supply.event_supplements.read') @UseGuards(SupplyPermissionGuard)
  get(@Req() req: Request, @Param('eventSupplementId') eventSupplementId: string) { const c = this.context(req); return this.eventSupplements.get(c.tenantId, eventSupplementId) }

  /** Rate Impact Preview (spec section 7): read-only, never a mutation, so a read permission is enough. */
  @Post('event-supplements/preview') @RequireSupplyPermission('supply.event_supplements.read') @UseGuards(SupplyPermissionGuard)
  preview(@Req() req: Request, @Body() body: EventSupplementPreviewRequest) { const c = this.context(req); return this.eventSupplements.preview(c.tenantId, body) }

  @Post('event-supplements') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  create(@Req() req: Request, @Body() body: EventSupplementWrite) { const c = this.context(req); return this.eventSupplements.create(c.tenantId, c.userId, body) }

  @Post('event-supplements/:eventSupplementId/submit') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  submit(@Req() req: Request, @Param('eventSupplementId') eventSupplementId: string, @Body() body: EventSupplementActivationRequestInput) { const c = this.context(req); return this.eventSupplements.submit(c.tenantId, c.userId, eventSupplementId, { ...body, requestId: body?.requestId ?? c.requestId }) }

  @Post('event-supplements/:eventSupplementId/activate') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  activate(@Req() req: Request, @Param('eventSupplementId') eventSupplementId: string, @Body() body: { reason: string }) { const c = this.context(req); return this.eventSupplements.activate(c.tenantId, c.userId, eventSupplementId, body) }

  @Post('event-supplements/:eventSupplementId/suspend') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  suspend(@Req() req: Request, @Param('eventSupplementId') eventSupplementId: string, @Body() body: EventSupplementSuspendInput) { const c = this.context(req); return this.eventSupplements.suspend(c.tenantId, c.userId, eventSupplementId, body) }

  @Post('event-supplements/:eventSupplementId/amendment-request') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  requestAmendment(@Req() req: Request, @Param('eventSupplementId') eventSupplementId: string, @Body() body: EventSupplementAmendmentRequestInput) { const c = this.context(req); return this.eventSupplements.requestAmendment(c.tenantId, c.userId, eventSupplementId, { ...body, requestId: body?.requestId ?? c.requestId }) }

  @Post('event-supplement-approvals/:approvalId/approve') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  approve(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: EventSupplementApprovalDecisionInput) { const c = this.context(req); return this.eventSupplements.decide(c.tenantId, c.userId, approvalId, 'APPROVED', body) }

  @Post('event-supplement-approvals/:approvalId/reject') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  reject(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: EventSupplementApprovalDecisionInput) { const c = this.context(req); return this.eventSupplements.decide(c.tenantId, c.userId, approvalId, 'REJECTED', body) }

  @Post('event-supplement-approvals/:approvalId/cancel') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  cancelApproval(@Req() req: Request, @Param('approvalId') approvalId: string) { const c = this.context(req); return this.eventSupplements.cancelApproval(c.tenantId, c.userId, approvalId) }

  /** Applies an approved AMENDMENT (named by the approvalId, mirroring contractApprovalExecute); an ACTIVATION approval is applied via
   * the entity's own /activate route instead. */
  @Post('event-supplement-approvals/:approvalId/execute') @RequireSupplyPermission('supply.event_supplements.manage') @UseGuards(SupplyPermissionGuard)
  execute(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: EventSupplementApprovalExecuteInput) { const c = this.context(req); return this.eventSupplements.execute(c.tenantId, c.userId, approvalId, body) }
}
