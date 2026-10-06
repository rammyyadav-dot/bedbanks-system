import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import type { BookingAccessView } from '@bedbanks/contracts'
import { membershipGrantsPermission } from '../agent/agent-permissions'
import { activeTenantId, sessionTenantId } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'

const ACCESS_KEY = 'fbeds:booking-access'

/**
 * Who may read bookings, and how much (ADR 0039). Fails closed.
 *
 *   OPERATOR  `booking.read` (existing: formal role, or legacy owner membership): every agency of the operator tenant.
 *   AGENCY    `booking.view.agency` (formal role only): the caller's own agency only; a caller with no agency membership is refused.
 *   net rate, margin: `booking.view.net`, guest names unmasked: `booking.pii.view`: formal roles only, never implied by owner membership.
 *
 * The tenant comes only from the authenticated session. Denials are audited like every other guard.
 */
@Injectable()
export class BookingAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    if (!identity) throw new ForbiddenException('Access denied')
    const tenantId = activeTenantId(request)
    if (sessionTenantId(identity, tenantId) !== tenantId) throw new ForbiddenException('Access denied')
    const userId = identity.user.id
    const membership = await this.prisma.withTenant(tenantId, (tx) => tx.membership.findUnique({ where: { userId_tenantId: { userId, tenantId } }, include: { tenant: true } }))
    if (!membership || membership.tenantId !== tenantId || membership.tenant.status !== 'ACTIVE') throw new ForbiddenException('Insufficient permission')
    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({
      where: { userId, tenantId, role: { tenantId } },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    }))
    const formal = roles.flatMap((assignment) => assignment.role.permissions.map((item) => item.permission.key))
    const operator = membershipGrantsPermission(membership.role, formal, 'booking.read')
    const agencyReader = formal.includes('booking.view.agency')
    let agencyId: string | null = null
    if (!operator && agencyReader) {
      const member = await this.prisma.withTenant(tenantId, (tx) => tx.agencyMember.findUnique({ where: { tenantId_userId: { tenantId, userId } }, select: { agencyId: true } }))
      agencyId = member?.agencyId ?? null
    }
    if (!operator && (!agencyReader || !agencyId)) {
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, actorType: 'USER', action: 'permission.denied', entityType: 'permission', entityId: agencyReader ? 'booking.view.agency' : 'booking.read', payload: { tenantId, requestId: (request as unknown as { requestId?: string }).requestId ?? null }, userId } })).catch(() => undefined)
      throw new ForbiddenException('Access denied')
    }
    const access: BookingAccessView = { level: operator ? 'OPERATOR' : 'AGENCY', canViewNet: formal.includes('booking.view.net'), canViewPii: formal.includes('booking.pii.view'), agencyId: operator ? null : agencyId }
    ;(request as unknown as Record<string, unknown>)[ACCESS_KEY] = access
    return true
  }
}

/** The access the guard resolved for this request. Absent only if the guard was not applied, which is refused. */
export const BookingAccess = createParamDecorator((_data: unknown, context: ExecutionContext): BookingAccessView => {
  const access = (context.switchToHttp().getRequest<Request>() as unknown as Record<string, unknown>)[ACCESS_KEY] as BookingAccessView | undefined
  if (!access) throw new ForbiddenException('Access denied')
  return access
})
