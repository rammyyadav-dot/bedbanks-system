import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { PrismaService } from '../database/prisma.service'
import { activeTenantId } from './tenant-context.guard'

export const ALLOW_WHEN_AGENCY_SUSPENDED = 'fbeds:allow-when-agency-suspended'
/** Marks an Agent handler that stays available to a suspended agency: reads, and winding down what already exists. */
export const AllowWhenAgencySuspended = () => SetMetadata(ALLOW_WHEN_AGENCY_SUSPENDED, true)

/**
 * Blocks new commercial activity (search, recheck, hold, prebook, booking) for members of a SUSPENDED agency (ADR 0020).
 * Fails closed by handler: a route is blocked unless it opts out with AllowWhenAgencySuspended. A user who belongs to no agency is unaffected.
 *
 * Policy, stated once: if the agency table cannot be read (for example the runtime role has not been granted it yet) the guard
 * lets the request through and logs a warning, because failing closed would block every agent in the tenant. Suspension is an
 * exposure control layered on RBAC, not an authentication step.
 */
@Injectable()
export class AgencySuspensionGuard implements CanActivate {
  private readonly logger = new Logger(AgencySuspensionGuard.name)
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_WHEN_AGENCY_SUSPENDED, [context.getHandler(), context.getClass()])) return true
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    if (!identity) throw new ForbiddenException('Access denied')
    const tenantId = activeTenantId(request)
    let suspended = false
    try {
      const member = await this.prisma.withTenant(tenantId, (tx) => tx.agencyMember.findFirst({ where: { tenantId, userId: identity.user.id }, select: { agency: { select: { status: true } } } }))
      suspended = member?.agency.status === 'SUSPENDED'
    } catch (error) {
      this.logger.warn(`Agency status unreadable; suspension not enforced for this request (${(error as { code?: string }).code ?? 'unknown'})`)
    }
    if (suspended) throw new ForbiddenException('Your agency is suspended. Contact your account manager.')
    return true
  }
}
