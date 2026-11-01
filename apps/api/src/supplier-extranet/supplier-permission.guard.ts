import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { activeTenantId } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { REQUEST_USER_KEY } from '../auth/auth.constants'
import { SupplierExtranetService } from './supplier-extranet.service'

export const SUPPLIER_PERMISSION_KEY = 'fbeds:supplier-permission'
/** Routes that answer only about the caller's own memberships declare SELF instead of a permission key. */
export const SUPPLIER_SELF = 'SELF'

/** Every route on a supplier extranet controller must declare the permission it needs. The services still check it too (defence in depth). */
export const RequireSupplierPermission = (permission: string) => SetMetadata(SUPPLIER_PERMISSION_KEY, permission)

@Injectable()
export class SupplierPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly extranet: SupplierExtranetService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(SUPPLIER_PERMISSION_KEY, [context.getHandler(), context.getClass()])
    // Fail closed: a route that forgot to declare its permission is refused.
    if (!required) throw new ForbiddenException('Access denied')
    if (required === SUPPLIER_SELF) return true
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as Record<string, AuthenticatedUser | undefined>)[REQUEST_USER_KEY]
    if (!identity?.user?.id) throw new ForbiddenException('Access denied')
    await this.extranet.requirePermission(activeTenantId(request), identity.user.id, required)
    return true
  }
}
