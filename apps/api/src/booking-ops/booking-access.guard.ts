import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { BookingAccessView } from '@bedbanks/contracts'
import { membershipGrantsPermission } from '../agent/agent-permissions'
import { activeTenantId, sessionTenantId } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'

const ACCESS_KEY = 'fbeds:booking-access'
export const REQUIRED_BOOKING_ACTION = 'fbeds:booking-action-permissions'

/** Declares the formal permissions of which the caller must hold at least one (Phase 2 write routes). The route's service then checks the one named action. */
export const RequireBookingAction = (...keys: string[]) => SetMetadata(REQUIRED_BOOKING_ACTION, keys)
export const supplierDispatchEnabled = (env: Record<string, string | undefined> = process.env) => env.ADMIN_SUPPLIER_JOBS_ENABLED === 'true'
export const bookingOpsQueueEnabled = (env: Record<string, string | undefined> = process.env) => env.ADMIN_BOOKING_OPS_ENABLED === 'true'
export const manualBookingEnabled = (env: Record<string, string | undefined> = process.env) => env.ADMIN_MANUAL_BOOKING_ENABLED === 'true'

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
  constructor(private readonly prisma: PrismaService, private readonly reflector: Reflector) {}

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
    const required = this.reflector.get<string[] | undefined>(REQUIRED_BOOKING_ACTION, context.getHandler())
    // Write routes: the caller must hold one of the declared action permissions as a formal role (owner membership implies none), and, for agency callers, be tied to an agency.
    const holdsAction = !required || required.some((key) => formal.includes(key))
    const scoped = operator || (agencyReader && Boolean(agencyId))
    if (!holdsAction || !scoped || (required && !operator && !agencyId)) {
      await this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.create({ data: { tenantId, actorType: 'USER', action: 'permission.denied', entityType: 'permission', entityId: agencyReader ? 'booking.view.agency' : 'booking.read', payload: { tenantId, requestId: (request as unknown as { requestId?: string }).requestId ?? null }, userId } })).catch(() => undefined)
      throw new ForbiddenException(required?.some((k) => k.startsWith('booking.ops.')) ? { message: 'Access denied', code: 'BOOKING_OPS_FORBIDDEN' } : 'Access denied')
    }
    const permissions = formal.filter((key) => key.startsWith('booking.'))
    const access: BookingAccessView = { level: operator ? 'OPERATOR' : 'AGENCY', canViewNet: formal.includes('booking.view.net'), canViewPii: formal.includes('booking.pii.view'), agencyId: operator ? null : agencyId, permissions, manualEntry: operator && formal.includes('booking.manual.create') && manualBookingEnabled(), supplierDispatch: operator && formal.includes('booking.supplier.retry') && supplierDispatchEnabled(), opsQueue: operator && formal.includes('booking.ops.view') && bookingOpsQueueEnabled() }
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
