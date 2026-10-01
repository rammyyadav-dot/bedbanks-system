import { Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { sanitizeAuditPayload } from './audit-payload'

@Injectable()
export class AgentAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: { tenantId?: string; user?: AuthenticatedUser; userId?: string; action: string; entityType: string; entityId: string; payload: Record<string, unknown> }) {
    const payload = sanitizeAuditPayload(input.payload)
    const actorUserId = input.user?.user.id ?? input.userId
    if (!input.tenantId) {
      return this.prisma.auditEvent.create({
        data: {
          userId: actorUserId,
          actorType: actorUserId ? 'USER' : 'SYSTEM',
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
        userId: actorUserId,
        actorType: actorUserId ? 'USER' : 'SYSTEM',
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
