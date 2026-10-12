import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import type { RatePlanActivationRequestInput, RatePlanApprovalDecisionInput } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { TenantContextGuard, ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { RatePlanApprovalService } from './rate-plan-approval.service'

/** Routes live in @bedbanks/contracts (supplyRoutes.ratePlanActivationRequest, ...). Tenant and user come only from the session. */
@Controller('supply')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class RatePlanApprovalController {
  constructor(private readonly approvals: RatePlanApprovalService) {}
  private context(req: Request) {
    const user = (req as unknown as { user: AuthenticatedUser }).user
    return { tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY], userId: user.user.id, requestId: (req as unknown as { requestId?: string }).requestId ?? req.header('x-request-id') ?? undefined }
  }
  @Get('rate-plans/:ratePlanId/activation-approval') latest(@Req() req: Request, @Param('ratePlanId') ratePlanId: string) { const c = this.context(req); return this.approvals.latest(c.tenantId, c.userId, ratePlanId) }
  @Post('rate-plans/:ratePlanId/activation-request') request(@Req() req: Request, @Param('ratePlanId') ratePlanId: string, @Body() body: RatePlanActivationRequestInput) { const c = this.context(req); return this.approvals.request(c.tenantId, c.userId, ratePlanId, body, c.requestId) }
  @Post('rate-plan-approvals/:approvalId/approve') approve(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: RatePlanApprovalDecisionInput) { const c = this.context(req); return this.approvals.decide(c.tenantId, c.userId, approvalId, 'APPROVED', body) }
  @Post('rate-plan-approvals/:approvalId/reject') reject(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: RatePlanApprovalDecisionInput) { const c = this.context(req); return this.approvals.decide(c.tenantId, c.userId, approvalId, 'REJECTED', body) }
  @Post('rate-plan-approvals/:approvalId/cancel') cancel(@Req() req: Request, @Param('approvalId') approvalId: string) { const c = this.context(req); return this.approvals.cancel(c.tenantId, c.userId, approvalId) }
  @Post('rate-plan-approvals/:approvalId/execute') execute(@Req() req: Request, @Param('approvalId') approvalId: string) { const c = this.context(req); return this.approvals.execute(c.tenantId, c.userId, approvalId, c.requestId) }
}
