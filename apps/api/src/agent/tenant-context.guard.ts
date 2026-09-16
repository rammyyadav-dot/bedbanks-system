import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'

export const ACTIVE_TENANT_HEADER = 'x-fbeds-tenant-id'
export const ACTIVE_TENANT_REQUEST_KEY = 'activeTenantId'

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    const tenantId = request.header(ACTIVE_TENANT_HEADER)
    if (!identity || !tenantId) throw new ForbiddenException('A valid active tenant is required')
    const membership = await this.prisma.membership.findUnique({ where: { userId_tenantId: { userId: identity.user.id, tenantId } }, include: { tenant: true } })
    if (!membership || membership.tenant.status !== 'ACTIVE') throw new ForbiddenException('A valid active tenant is required')
    ;(request as unknown as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY] = tenantId
    return true
  }
}
