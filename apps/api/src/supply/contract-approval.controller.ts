import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
import type { ContractActivationRequestInput, ContractAmendmentRequestInput, ContractApprovalDecisionInput, ContractTransitionInput } from '@bedbanks/contracts'
import { SessionAuthGuard } from '../auth/guards/session-auth.guard'
import { TenantContextGuard, ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { RequireSupplyPermission, SupplyPermissionGuard } from '../admin-operations/supply-permission.guard'
import { ContractApprovalService } from './contract-approval.service'

/** Routes live in @bedbanks/contracts (contractLifecycleRoutes). Tenant and user come only from the session. Each route declares the permission
 * its service method enforces (route guard first, service check kept as defence in depth); approval-only keys are enforced by ApprovalService. */
@Controller('supply')
@UseGuards(SessionAuthGuard, TenantContextGuard)
export class ContractApprovalController {
  constructor(private readonly contracts: ContractApprovalService) {}
  private context(req: Request) {
    const user = (req as unknown as { user: AuthenticatedUser }).user
    return { tenantId: (req as unknown as Record<string, string>)[ACTIVE_TENANT_REQUEST_KEY], userId: user.user.id, requestId: (req as unknown as { requestId?: string }).requestId ?? req.header('x-request-id') ?? undefined }
  }
  @Get('contracts/:contractId/lifecycle') @RequireSupplyPermission('supply.contracts.read') @UseGuards(SupplyPermissionGuard) lifecycle(@Req() req: Request, @Param('contractId') contractId: string) { const c = this.context(req); return this.contracts.lifecycle(c.tenantId, c.userId, contractId) }
  @Post('contracts/:contractId/submit') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) submit(@Req() req: Request, @Param('contractId') contractId: string, @Body() body: ContractTransitionInput) { const c = this.context(req); return this.contracts.transition(c.tenantId, c.userId, contractId, 'submit', body, c.requestId) }
  @Post('contracts/:contractId/return-to-draft') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) returnToDraft(@Req() req: Request, @Param('contractId') contractId: string, @Body() body: ContractTransitionInput) { const c = this.context(req); return this.contracts.transition(c.tenantId, c.userId, contractId, 'return', body, c.requestId) }
  @Post('contracts/:contractId/suspend') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) suspend(@Req() req: Request, @Param('contractId') contractId: string, @Body() body: ContractTransitionInput) { const c = this.context(req); return this.contracts.transition(c.tenantId, c.userId, contractId, 'suspend', body, c.requestId) }
  @Post('contracts/:contractId/activation-request') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) requestActivation(@Req() req: Request, @Param('contractId') contractId: string, @Body() body: ContractActivationRequestInput) { const c = this.context(req); return this.contracts.requestActivation(c.tenantId, c.userId, contractId, body, c.requestId) }
  @Post('contracts/:contractId/amendment-request') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) requestAmendment(@Req() req: Request, @Param('contractId') contractId: string, @Body() body: ContractAmendmentRequestInput) { const c = this.context(req); return this.contracts.requestAmendment(c.tenantId, c.userId, contractId, body, c.requestId) }
  @Post('contract-approvals/:approvalId/approve') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) approve(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: ContractApprovalDecisionInput) { const c = this.context(req); return this.contracts.decide(c.tenantId, c.userId, approvalId, 'APPROVED', body) }
  @Post('contract-approvals/:approvalId/reject') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) reject(@Req() req: Request, @Param('approvalId') approvalId: string, @Body() body: ContractApprovalDecisionInput) { const c = this.context(req); return this.contracts.decide(c.tenantId, c.userId, approvalId, 'REJECTED', body) }
  @Post('contract-approvals/:approvalId/cancel') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) cancel(@Req() req: Request, @Param('approvalId') approvalId: string) { const c = this.context(req); return this.contracts.cancel(c.tenantId, c.userId, approvalId) }
  @Post('contract-approvals/:approvalId/execute') @RequireSupplyPermission('supply.contracts.manage') @UseGuards(SupplyPermissionGuard) execute(@Req() req: Request, @Param('approvalId') approvalId: string) { const c = this.context(req); return this.contracts.execute(c.tenantId, c.userId, approvalId, c.requestId) }
}
