import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { REQUEST_USER_KEY } from '../auth/auth.constants'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import { AgentAuditService } from '../agent/audit.service'
import { ApprovalService } from './approval.service'
import { STEP_UP_FIELD } from '@bedbanks/contracts'
import { StepUpService } from './step-up.service'

export const REQUIRED_STEP_UP = 'fbeds:required-step-up'
export const REQUIRED_DUAL_APPROVAL = 'fbeds:required-dual-approval'

interface Requirement { action: string; param: string }

/**
 * Checker decisions: the signed-in user must re-enter their password in `stepUpPassword`. `action` is the permission key being exercised
 * (audit only); `param` names the route parameter that identifies the entity (default `approvalId`). Use with StepUpGuard, after the permission guard.
 */
export const RequireStepUp = (action: string, param = 'approvalId') => SetMetadata(REQUIRED_STEP_UP, { action, param } satisfies Requirement)

/**
 * Execution routes: refuses a direct call unless route parameter `approvalId` names an APPROVED request for exactly `action`, in this tenant,
 * decided by someone other than the person who asked. Defence in depth: the owning service claims the approval and re-validates the domain rules too.
 * Use with DualApprovalGuard, after the permission guard.
 */
export const RequireDualApproval = (action: string) => SetMetadata(REQUIRED_DUAL_APPROVAL, { action, param: 'approvalId' } satisfies Requirement)

type Req = Request & { [ACTIVE_TENANT_REQUEST_KEY]?: string }

function actor(request: Req): { userId: string; tenantId: string } {
  const identity = (request as unknown as Record<string, AuthenticatedUser | undefined>)[REQUEST_USER_KEY]
  const tenantId = request[ACTIVE_TENANT_REQUEST_KEY]
  // Identity and tenant come from the session and TenantContextGuard only, never from the body or query. Missing either means a guard did not run: deny.
  if (!identity || typeof tenantId !== 'string' || !tenantId) throw new ForbiddenException('Access denied')
  return { userId: identity.user.id, tenantId }
}

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly stepUp: StepUpService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Req>()
    const required = this.reflector.getAllAndOverride<Requirement | undefined>(REQUIRED_STEP_UP, [context.getHandler(), context.getClass()])
    if (!required) throw new ForbiddenException('Access denied')
    const { userId, tenantId } = actor(request)
    // Take the password out of the body first, whatever happens next, so no later layer can log or persist it.
    const body = request.body as Record<string, unknown> | undefined
    const password = body?.[STEP_UP_FIELD]
    if (body && typeof body === 'object') delete body[STEP_UP_FIELD]
    const entityId = String(request.params?.[required.param] ?? 'unknown').slice(0, 128)
    await this.stepUp.verify({ tenantId, userId, password, action: required.action, entityId })
    return true
  }
}

@Injectable()
export class DualApprovalGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly approvals: ApprovalService, private readonly audit: AgentAuditService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Req>()
    const required = this.reflector.getAllAndOverride<Requirement | undefined>(REQUIRED_DUAL_APPROVAL, [context.getHandler(), context.getClass()])
    if (!required) throw new ForbiddenException('Access denied')
    const { userId, tenantId } = actor(request)
    const approvalId = request.params?.[required.param]
    if (typeof approvalId !== 'string' || !approvalId) throw new ForbiddenException('Access denied')

    const approval = await this.approvals.get(tenantId, approvalId)
    const reason =
      approval.action !== required.action ? 'ACTION_MISMATCH'
      : approval.status !== 'APPROVED' ? `NOT_APPROVED_${approval.status}`
      : !approval.decidedById || approval.decidedById === approval.requestedById ? 'NO_INDEPENDENT_APPROVER'
      : null
    if (reason) {
      // Admin A (requestedById), Admin B (decidedById) and the caller are all on the record, with the address from the request context.
      await this.audit.record({
        tenantId, userId, action: 'approval.bypass_refused', entityType: 'approval_request', entityId: approval.id,
        payload: { approvalAction: required.action, reason, requestedById: approval.requestedById, decidedById: approval.decidedById, status: approval.status },
      }).catch(() => undefined)
      throw new ForbiddenException({ message: 'This action needs an approval from a second person', code: 'DUAL_APPROVAL_REQUIRED', reason })
    }
    return true
  }
}
