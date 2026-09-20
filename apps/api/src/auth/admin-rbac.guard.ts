import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { AuthenticatedUser } from './interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'

export const REQUIRED_ADMIN_PERMISSION = 'fbeds:required-admin-permission'
export type AdminPermission =
  | 'dashboard.read'
  | 'bookings.read' | 'bookings.manage'
  | 'hotels.read' | 'hotels.manage'
  | 'suppliers.read' | 'suppliers.manage'
  | 'contracts.read' | 'contracts.manage'
  | 'inventory.read' | 'inventory.manage'
  | 'rates.read' | 'rates.manage'
  | 'pricing.read' | 'pricing.manage'
  | 'finance.read' | 'finance.manage'
  | 'users.read' | 'users.manage'
  | 'roles.read' | 'roles.manage'
  | 'audit.read' | 'settings.manage'

export const RequireAdminPermission = (permission: AdminPermission) => SetMetadata(REQUIRED_ADMIN_PERMISSION, permission)

type RoleAssignment = { role: { permissions: Array<{ permission: { key: string } }> } }

@Injectable()
export class AdminRbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    const required = this.reflector.getAllAndOverride<AdminPermission>(REQUIRED_ADMIN_PERMISSION, [context.getHandler(), context.getClass()])
    if (!identity || !required) throw new ForbiddenException('Access denied')

    const membership = identity.memberships.find((entry) => entry.role === 'owner') ?? identity.memberships[0]
    if (!membership) throw new ForbiddenException('No active tenant membership')

    const roles = await this.prisma.withTenant(membership.tenantId, (tx) => tx.userRole.findMany({
      where: { userId: identity.user.id, tenantId: membership.tenantId, role: { tenantId: membership.tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    })) as RoleAssignment[]
    const permissions = new Set(roles.flatMap((assignment) => assignment.role.permissions.map((entry) => entry.permission.key)))
    const allowed = membership.role === 'owner' || permissions.has(required)
    if (!allowed) {
      await this.prisma.withTenant(membership.tenantId, (tx) => tx.auditEvent.create({
        data: { tenantId: membership.tenantId, actorType: 'USER', action: 'permission.denied', entityType: 'admin_permission', entityId: required, payload: { permission: required }, userId: identity.user.id },
      })).catch(() => undefined)
      throw new ForbiddenException('Insufficient permission')
    }
    return true
  }
}

export const RequirePermission = RequireAdminPermission
