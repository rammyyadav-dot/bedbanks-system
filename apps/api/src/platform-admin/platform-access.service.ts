import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'

const platformPermissions = [
  ['platform.tenants.read', 'Read the platform tenant directory.'],
  ['platform.tenants.access', 'Enter a tenant-scoped support context.'],
  ['platform.access.read', 'Read platform roles, permissions, and assignments.'],
  ['platform.access.manage', 'Manage platform roles, permissions, and assignments.'],
] as const

@Injectable()
export class PlatformAccessService {
  constructor(private readonly prisma: PrismaService) {}

  listPermissions(operatorUserId: string) {
    return this.prisma.withPlatform(operatorUserId, (tx) => tx.platformPermission.findMany({ orderBy: { key: 'asc' }, include: { roles: { select: { roleId: true } } } }))
  }

  listRoles(operatorUserId: string) {
    return this.prisma.withPlatform(operatorUserId, (tx) => tx.platformRole.findMany({ orderBy: { name: 'asc' }, include: { permissions: { include: { permission: true } }, _count: { select: { assignments: true } } } }))
  }

  listAssignments(operatorUserId: string) {
    return this.prisma.withPlatform(operatorUserId, (tx) => tx.platformRoleAssignment.findMany({ orderBy: { createdAt: 'desc' }, include: { role: true, user: { select: { id: true, email: true, name: true } } } }))
  }

  async createRole(operatorUserId: string, input: { id: string; name: string; description?: string }) {
    if (!/^[a-z0-9._-]+$/.test(input.id) || !input.name.trim()) throw new BadRequestException('Invalid platform role')
    return this.prisma.withPlatform(operatorUserId, async (tx) => {
      const role = await tx.platformRole.create({ data: { id: input.id, name: input.name.trim(), description: input.description?.trim() || null } })
      await tx.auditEvent.create({ data: { tenantId: null, userId: operatorUserId, actorType: 'USER', action: 'platform.role.created', entityType: 'platform_role', entityId: role.id, payload: { outcome: 'allowed' } } })
      return role
    })
  }

  async setRolePermissions(operatorUserId: string, roleId: string, permissionIds: string[]) {
    return this.prisma.withPlatform(operatorUserId, async (tx) => {
      const role = await tx.platformRole.findUnique({ where: { id: roleId } })
      if (!role) throw new NotFoundException('Platform role not found')
      const valid = await tx.platformPermission.findMany({ where: { id: { in: permissionIds } }, select: { id: true } })
      if (valid.length !== new Set(permissionIds).size) throw new BadRequestException('Unknown platform permission')
      await tx.platformRolePermission.deleteMany({ where: { roleId } })
      if (valid.length) await tx.platformRolePermission.createMany({ data: valid.map(({ id }) => ({ roleId, permissionId: id })) })
      await tx.auditEvent.create({ data: { tenantId: null, userId: operatorUserId, actorType: 'USER', action: 'platform.role.permissions.updated', entityType: 'platform_role', entityId: roleId, payload: { outcome: 'allowed', permissionIds: valid.map(({ id }) => id) } } })
      return tx.platformRole.findUnique({ where: { id: roleId }, include: { permissions: { include: { permission: true } } } })
    })
  }

  async assignRole(operatorUserId: string, input: { userId: string; roleId: string }) {
    if (operatorUserId === input.userId) throw new BadRequestException('Self-escalation is not permitted')
    return this.prisma.withPlatform(operatorUserId, async (tx) => {
      const [user, role] = await Promise.all([tx.user.findUnique({ where: { id: input.userId }, select: { id: true } }), tx.platformRole.findUnique({ where: { id: input.roleId }, select: { id: true } })])
      if (!user || !role) throw new NotFoundException('Platform user or role not found')
      const assignment = await tx.platformRoleAssignment.create({ data: { userId: input.userId, roleId: input.roleId } })
      await tx.auditEvent.create({ data: { tenantId: null, userId: operatorUserId, actorType: 'USER', action: 'platform.role.assigned', entityType: 'platform_role_assignment', entityId: `${input.userId}:${input.roleId}`, payload: { outcome: 'allowed', targetUserId: input.userId, roleId: input.roleId } } })
      return assignment
    })
  }

  async revokeRole(operatorUserId: string, input: { userId: string; roleId: string }) {
    if (operatorUserId === input.userId) throw new BadRequestException('Self-revocation is not permitted')
    return this.prisma.withPlatform(operatorUserId, async (tx) => {
      await tx.platformRoleAssignment.delete({ where: { userId_roleId: input } })
      await tx.auditEvent.create({ data: { tenantId: null, userId: operatorUserId, actorType: 'USER', action: 'platform.role.revoked', entityType: 'platform_role_assignment', entityId: `${input.userId}:${input.roleId}`, payload: { outcome: 'allowed', targetUserId: input.userId, roleId: input.roleId } } })
      return { revoked: true }
    })
  }
}

export { platformPermissions }
