import { Injectable } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'

@Injectable()
export class AgentAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: { tenantId?: string; user?: AuthenticatedUser; action: string; entityType: string; entityId: string; payload: Record<string, unknown> }) {
    return this.prisma.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        userId: input.user?.user.id,
        actorType: input.user ? 'USER' : 'SYSTEM',
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payload as any,
      },
    })
  }

  async list(tenantId: string, limit = 50) {
    return this.prisma.auditEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100) })
  }
}
