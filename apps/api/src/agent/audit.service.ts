import { Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { sanitizeAuditPayload } from './audit-payload'
import { currentRequestContext } from '../common/request-context'

@Injectable()
export class AgentAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: { tenantId?: string; user?: AuthenticatedUser; userId?: string; action: string; entityType: string; entityId: string; payload: Record<string, unknown> }) {
    // Every event written inside an HTTP request carries the caller's address and request id, so an investigator can tie it back to a request.
    const context = currentRequestContext()
    const payload = sanitizeAuditPayload({ ...(context ? { ip: context.ip, requestId: context.requestId } : {}), ...input.payload })
    const actorUserId = input.user?.user.id ?? input.userId
    if (!input.tenantId) {
      // tenant-scope: tenantless SYSTEM audit event; no tenant context exists for this record
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
