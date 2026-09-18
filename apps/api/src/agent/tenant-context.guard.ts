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
    if (!identity || !tenantId) throw new ForbiddenException('Access denied')
    // The header identifies the requested workspace only. The authenticated
    // user ID plus RLS-scoped membership lookup determines whether it is valid.
    const membership = await this.prisma.withTenant(tenantId, (tx) => tx.membership.findUnique({ where: { userId_tenantId: { userId: identity.user.id, tenantId } }, include: { tenant: true } }))
    if (!membership || membership.tenant.status !== 'ACTIVE') {
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, actorType: identity ? 'USER' : 'SYSTEM', action: 'tenant.access.denied', entityType: 'tenant', entityId: tenantId, payload: { reason: 'inactive_or_missing_membership' }, userId: identity?.user.id } })).catch(() => undefined)
      throw new ForbiddenException('Access denied')
    }
    await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, actorType: 'USER', action: 'tenant.context.selected', entityType: 'tenant', entityId: tenantId, payload: { source: 'request_context' }, userId: identity.user.id } })).catch(() => undefined)
    ;(request as unknown as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY] = tenantId
    return true
  }
}
