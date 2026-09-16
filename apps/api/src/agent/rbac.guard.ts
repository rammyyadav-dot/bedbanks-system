import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'
import { PERMISSIONS, type AgentPermission } from './supplier.port'

export const REQUIRED_PERMISSION = 'fbeds:required-permission'
export const RequirePermission = (permission: AgentPermission) => SetMetadata(REQUIRED_PERMISSION, permission)

@Injectable()
export class AgentRbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    const tenantId = request.header('x-fbeds-tenant-id')
    const required = this.reflector.getAllAndOverride<AgentPermission>(REQUIRED_PERMISSION, [context.getHandler(), context.getClass()])
    if (!identity || !tenantId) throw new ForbiddenException('Insufficient permission')
    const membership = await this.prisma.membership.findUnique({ where: { userId_tenantId: { userId: identity.user.id, tenantId } }, include: { tenant: true } })
    if (!membership || membership.tenant.status !== 'ACTIVE') throw new ForbiddenException('Insufficient permission')
    if (!required) return true
    const roles = await this.prisma.userRole.findMany({ where: { userId: identity.user.id, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } })
    const formalPermissions = roles.flatMap((item) => item.role.permissions.map((permission) => permission.permission.key))
    const legacyAllowed = membership.role === 'owner' || (required === PERMISSIONS.viewFinance && membership.role === 'finance')
    if (!formalPermissions.includes(required) && !legacyAllowed) throw new ForbiddenException('Insufficient permission')
    return true
  }
}
