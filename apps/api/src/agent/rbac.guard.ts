import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PERMISSIONS, type AgentPermission } from './supplier.port'

export const REQUIRED_PERMISSION = 'fbeds:required-permission'
export const RequirePermission = (permission: AgentPermission) => SetMetadata(REQUIRED_PERMISSION, permission)

@Injectable()
export class AgentRbacGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    const required = context.getHandler().toString().includes('finance') ? PERMISSIONS.viewFinance : undefined
    if (!identity || (required && !identity.memberships.some((membership) => membership.role === 'owner' || membership.role === 'finance'))) {
      throw new ForbiddenException('Insufficient permission')
    }
    return true
  }
}
