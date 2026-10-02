import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'
import { membershipGrantsPermission } from './agent-permissions'
import type { AgentPermission } from './supplier.port'
import { activeTenantId, sessionTenantId } from './tenant-context.guard'

export const REQUIRED_PERMISSION = 'fbeds:required-permission'
export const RequirePermission = (permission: AgentPermission) => SetMetadata(REQUIRED_PERMISSION, permission)

type FormalRoleAssignment = {
  role: {
    permissions: Array<{ permission: { key: string } }>
  }
}

@Injectable()
export class AgentRbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    const required = this.reflector.getAllAndOverride<AgentPermission>(REQUIRED_PERMISSION, [context.getHandler(), context.getClass()])
    if (!identity) throw new ForbiddenException('Access denied')
    const tenantId = activeTenantId(request)
    if (sessionTenantId(identity, tenantId) !== tenantId) throw new ForbiddenException('Access denied')
    const membership = await this.prisma.withTenant(tenantId, (tx) => tx.membership.findUnique({ where: { userId_tenantId: { userId: identity.user.id, tenantId } }, include: { tenant: true } }))
    if (!membership || membership.tenantId !== tenantId || membership.tenant.status !== 'ACTIVE') throw new ForbiddenException('Insufficient permission')
    // Fail closed: every handler behind this guard must declare its permission.
    if (!required) throw new ForbiddenException('Access denied')
    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({
      where: { userId: identity.user.id, tenantId, role: { tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })) as FormalRoleAssignment[]
    const formalPermissions = roles.flatMap((item) => item.role.permissions.map((permission) => permission.permission.key))
    if (!membershipGrantsPermission(membership.role, formalPermissions, required)) {
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, actorType: 'USER', action: 'permission.denied', entityType: 'permission', entityId: required, payload: { tenantId }, userId: identity.user.id } })).catch(() => undefined)
      throw new ForbiddenException('Access denied')
    }
    return true
  }
}
