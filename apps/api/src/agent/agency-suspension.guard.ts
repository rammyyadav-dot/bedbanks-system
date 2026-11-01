import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger, SetMetadata } from '@nestjs/common'
import { commercialControlException, controlReadFailure, logCommercialControlFailure } from '../supply/commercial-controls'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AGENCY_SUSPENDED_CODE, AGENCY_SUSPENDED_MESSAGE } from '@bedbanks/contracts'
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
 * Policy, stated once (ADR 0031, superseding ADR 0020 item 5): no agency membership is a valid absence and is unaffected. If the
 * agency tables cannot be read the request is refused with 503 COMMERCIAL_CONTROL_UNAVAILABLE and a structured diagnostic, because
 * "could not check" must never mean "not suspended".
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
      logCommercialControlFailure(this.logger, controlReadFailure('agency_suspension', error), request.requestId)
      throw commercialControlException()
    }
    if (suspended) throw new ForbiddenException({ message: AGENCY_SUSPENDED_MESSAGE, code: AGENCY_SUSPENDED_CODE })
    return true
  }
}
