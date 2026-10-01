import { CanActivate, ExecutionContext, ForbiddenException, Injectable, createParamDecorator } from '@nestjs/common'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'

export const ACTIVE_TENANT_HEADER = 'x-fbeds-tenant-id'
export const ACTIVE_TENANT_REQUEST_KEY = 'activeTenantId'

/**
 * The browser may name which of the session's memberships it wants.
 * The id used for every query is copied from that server-loaded membership
 * after a fresh database check. A header, body, or query value that is not
 * one of those memberships is ignored and the request is denied.
 */
export function sessionTenantId(identity: AuthenticatedUser, requested: unknown): string {
  const memberships = identity.memberships ?? []
  if (!identity.user?.id || memberships.length === 0) throw new ForbiddenException('Access denied')
  const allowed = new Set(memberships.map((membership) => membership.tenantId))
  if (requested === undefined || requested === '') {
    if (memberships.length !== 1) throw new ForbiddenException('Access denied')
    return memberships[0].tenantId
  }
  if (typeof requested !== 'string' || !allowed.has(requested)) throw new ForbiddenException('Access denied')
  const match = memberships.find((membership) => membership.tenantId === requested)
  if (!match) throw new ForbiddenException('Access denied')
  return match.tenantId
}

export function activeTenantId(request: Request): string {
  const value = (request as unknown as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY]
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ForbiddenException('Access denied')
  }
  return value
}

function requestedTenantHeader(request: Request): string | undefined {
  const raw = request.headers[ACTIVE_TENANT_HEADER]
  if (raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string') throw new ForbiddenException('Access denied')
  return raw
}

@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    if (!identity) throw new ForbiddenException('Access denied')
    const tenantId = sessionTenantId(identity, requestedTenantHeader(request))
    const membership = await this.prisma.withTenant(tenantId, (tx) => tx.membership.findUnique({
      where: { userId_tenantId: { userId: identity.user.id, tenantId } },
      include: { tenant: true },
    }))
    if (!membership || membership.tenantId !== tenantId || membership.tenant.status !== 'ACTIVE') {
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({
        data: {
          tenantId,
          actorType: 'USER',
          action: 'tenant.access.denied',
          entityType: 'tenant',
          entityId: tenantId,
          payload: { reason: 'inactive_or_missing_membership' },
          userId: identity.user.id,
        },
      })).catch(() => undefined)
      throw new ForbiddenException('Access denied')
    }
    await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        actorType: 'USER',
        action: 'tenant.context.selected',
        entityType: 'tenant',
        entityId: membership.tenantId,
        payload: { source: 'session_membership' },
        userId: identity.user.id,
      },
    })).catch(() => undefined)
    ;(request as unknown as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY] = membership.tenantId
    return true
  }
}

/**
 * The tenant that TenantContextGuard validated against the authenticated user's membership.
 * Handlers must use this instead of reading the raw x-fbeds-tenant-id header; it fails closed
 * if the guard did not run.
 */
export const ActiveTenant = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const tenantId = (context.switchToHttp().getRequest() as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY]
  if (typeof tenantId !== 'string' || !tenantId) throw new ForbiddenException('Access denied')
  return tenantId
})
