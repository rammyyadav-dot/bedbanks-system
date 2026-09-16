import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'

export const ACTIVE_TENANT_HEADER = 'x-fbeds-tenant-id'
export const ACTIVE_TENANT_REQUEST_KEY = 'activeTenantId'

@Injectable()
export class TenantContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    const tenantId = request.header(ACTIVE_TENANT_HEADER)
    if (!identity || !tenantId || !identity.memberships.some((membership) => membership.tenantId === tenantId)) {
      throw new ForbiddenException('A valid active tenant is required')
    }
    ;(request as unknown as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY] = tenantId
    return true
  }
}
