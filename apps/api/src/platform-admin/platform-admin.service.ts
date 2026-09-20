import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import type { PlatformTenantContext } from './platform-admin'

@Injectable()
export class PlatformAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listTenants(operatorUserId: string, requestId?: string) {
    return this.prisma.withPlatform(operatorUserId, async (tx) => {
      const tenants = await tx.tenant.findMany({ select: { id: true, name: true, slug: true, status: true, createdAt: true }, orderBy: { name: 'asc' } })
      await tx.auditEvent.create({ data: { tenantId: null, userId: operatorUserId, actorType: 'USER', action: 'platform.tenants.directory.read', entityType: 'platform_tenant_directory', entityId: 'platform.tenants.read', payload: { permission: 'platform.tenants.read', outcome: 'allowed', requestId: requestId ?? null, count: tenants.length } } })
      return tenants
    })
  }

  async getTenantSummary(context: PlatformTenantContext) {
    return this.prisma.withPlatformTenant(context.operatorUserId, context.targetTenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: context.targetTenantId }, select: { id: true, name: true, slug: true, status: true, createdAt: true } })
      if (!tenant) throw new NotFoundException('Tenant not found')
      const [memberships, bookings] = await Promise.all([
        tx.membership.count({ where: { tenantId: context.targetTenantId } }),
        tx.booking.count({ where: { tenantId: context.targetTenantId } }),
      ])
      await tx.auditEvent.create({ data: { tenantId: context.targetTenantId, userId: context.operatorUserId, actorType: 'USER', action: 'platform.tenant.context.entered', entityType: 'tenant', entityId: context.targetTenantId, payload: { permission: context.permission, outcome: 'allowed', requestId: context.requestId ?? null } } })
      return { tenant, counts: { memberships, bookings }, platformContext: { permission: context.permission, targetTenantId: context.targetTenantId } }
    })
  }
}
