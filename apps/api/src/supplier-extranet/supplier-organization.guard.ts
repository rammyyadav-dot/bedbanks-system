import { CanActivate, ExecutionContext, ForbiddenException, Injectable, createParamDecorator } from '@nestjs/common'
import type { Request } from 'express'
import { PrismaService } from '../database/prisma.service'
import { activeTenantId } from '../agent/tenant-context.guard'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { REQUEST_USER_KEY } from '../auth/auth.constants'

export const ACTIVE_SUPPLIER_HEADER = 'x-fbeds-supplier-id'
export const ACTIVE_SUPPLIER_REQUEST_KEY = 'activeSupplierId'

const SELECTABLE_SUPPLIER_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE'] as const

function requestedSupplierHeader(request: Request): string | undefined {
  const raw = request.headers[ACTIVE_SUPPLIER_HEADER]
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || raw.length === 0 || raw.trim() !== raw || raw.length > 128) {
    throw new ForbiddenException('Access denied')
  }
  return raw
}

/**
 * Resolves the supplier organization from the caller's active memberships in the
 * already validated tenant. A header is only a selector among those memberships.
 */
@Injectable()
export class SupplierOrganizationGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const identity = (request as unknown as Record<string, AuthenticatedUser | undefined>)[REQUEST_USER_KEY]
    if (!identity?.user?.id) throw new ForbiddenException('Access denied')
    const tenantId = activeTenantId(request)
    const requested = requestedSupplierHeader(request)
    const memberships = await this.prisma.withTenant(tenantId, (tx) => tx.supplierMembership.findMany({
      where: {
        tenantId,
        userId: identity.user.id,
        status: 'ACTIVE',
        supplier: { tenantId, status: { in: [...SELECTABLE_SUPPLIER_STATUSES] } },
      },
      select: { supplierId: true },
    }))
    if (memberships.length === 0) throw new ForbiddenException('Access denied')
    const supplierId = requested === undefined
      ? (memberships.length === 1 ? memberships[0].supplierId : undefined)
      : memberships.find((membership) => membership.supplierId === requested)?.supplierId
    if (!supplierId) throw new ForbiddenException('Access denied')
    ;(request as unknown as Record<string, unknown>)[ACTIVE_SUPPLIER_REQUEST_KEY] = supplierId
    return true
  }
}

export const ActiveSupplier = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const supplierId = (context.switchToHttp().getRequest() as Record<string, unknown>)[ACTIVE_SUPPLIER_REQUEST_KEY]
  if (typeof supplierId !== 'string' || !supplierId) throw new ForbiddenException('Access denied')
  return supplierId
})
