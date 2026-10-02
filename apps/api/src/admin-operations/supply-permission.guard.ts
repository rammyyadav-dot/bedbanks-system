import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { SupplyPermission } from '@bedbanks/contracts'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'
import { activeTenantId, sessionTenantId } from '../agent/tenant-context.guard'

export const REQUIRED_SUPPLY_PERMISSION = 'fbeds:required-supply-permission'
/** Declares which existing `supply.*` permission a hotel-commercial handler needs. No new permission names are introduced. */
export const RequireSupplyPermission = (permission: SupplyPermission) => SetMetadata(REQUIRED_SUPPLY_PERMISSION, permission)

/**
 * Same rule as the supply endpoints: the caller's formal role assignments in the active tenant must include the key.
 * Fails closed: a handler without a declared permission is denied, as is any caller without an active-tenant membership.
 */
@Injectable()
export class SupplyPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    if (!identity) throw new ForbiddenException('Access denied')
    const required = this.reflector.getAllAndOverride<SupplyPermission>(REQUIRED_SUPPLY_PERMISSION, [context.getHandler(), context.getClass()])
    if (!required) throw new ForbiddenException('Access denied')
    const tenantId = activeTenantId(request)
    if (sessionTenantId(identity, tenantId) !== tenantId) throw new ForbiddenException('Access denied')
    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({
      where: { userId: identity.user.id, tenantId, role: { tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    }))
    const keys = roles.flatMap((assignment) => assignment.role.permissions.map((item) => item.permission.key))
    if (!keys.includes(required)) {
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, actorType: 'USER', action: 'permission.denied', entityType: 'permission', entityId: required, payload: { tenantId }, userId: identity.user.id } })).catch(() => undefined)
      throw new ForbiddenException('Access denied')
    }
    return true
  }
}
