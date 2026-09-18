import { Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { sanitizeAuditPayload } from './audit-payload'

@Injectable()
export class AgentAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: { tenantId?: string; user?: AuthenticatedUser; action: string; entityType: string; entityId: string; payload: Record<string, unknown> }) {
    const payload = sanitizeAuditPayload(input.payload)
    if (!input.tenantId) {
      return this.prisma.auditEvent.create({
        data: {
          userId: input.user?.user.id,
          actorType: input.user ? 'USER' : 'SYSTEM',
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          payload,
        },
      })
    }

    return this.prisma.withTenant(input.tenantId, (tx) => tx.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        userId: input.user?.user.id,
        actorType: input.user ? 'USER' : 'SYSTEM',
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        payload,
      },
    }))
  }

  async list(tenantId: string, limit = 50) {
    return this.prisma.withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) }))
  }
}
