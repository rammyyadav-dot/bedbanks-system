import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { PrismaService } from '../database/prisma.service'
import { REQUEST_USER_KEY } from '../auth/auth.constants'
import { PLATFORM_PERMISSION_KEY } from './platform-admin'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'

@Injectable()
export class PlatformRbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(PLATFORM_PERMISSION_KEY, [context.getHandler(), context.getClass()])
    if (!required) return true
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as Record<string, unknown>)[REQUEST_USER_KEY] as AuthenticatedUser | undefined
    if (!identity?.user?.id) throw new ForbiddenException('Platform access denied')

    const assignment = await this.prisma.platformRoleAssignment.findFirst({
      where: { userId: identity.user.id, role: { permissions: { some: { permission: { key: required } } } } },
      select: { roleId: true },
    })
    if (!assignment) {
      await this.prisma.withPlatform(identity.user.id, (tx) => tx.auditEvent.create({
        data: { tenantId: null, userId: identity.user.id, actorType: 'USER', action: 'platform.access.denied', entityType: 'platform_permission', entityId: required, payload: { permission: required, outcome: 'denied' } },
      })).catch(() => undefined)
      throw new ForbiddenException('Platform access denied')
    }
    ;(request as unknown as Record<string, unknown>).platformPermission = required
    return true
  }
}
