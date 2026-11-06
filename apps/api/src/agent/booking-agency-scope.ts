import { ForbiddenException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { membershipGrantsPermission } from './agent-permissions'
import { PERMISSIONS } from './supplier.port'

/**
 * Who a caller may touch on the Agent booking paths.
 *
 * AGENCY    The caller has an AgencyMember row in this tenant. Every read and mutation is limited to that agency.
 *           A booking with no agency (historical, unassigned) is not theirs.
 * OPERATOR  The caller belongs to no agency and holds operator read: legacy owner membership or a formal `booking.read`
 *           role (ADR 0039). This grant is separate from agency membership. It is never inferred from a missing agency
 *           row alone, and an agency member is never widened to the whole tenant, even when they also hold `booking.read`.
 */
export type AgentBookingScope = { level: 'AGENCY'; agencyId: string } | { level: 'OPERATOR' }

/** Prisma constraint for the caller's agency. Empty for an operator. Callers pin `tenantId` on the same object literal. */
export function agencyConstraint(scope: AgentBookingScope): { agencyId: string } | Record<string, never> {
  return scope.level === 'AGENCY' ? { agencyId: scope.agencyId } : {}
}

/** Row lock for one booking. An agency caller locks only their own row, so another agency's booking is not locked or revealed. */
export function lockBookingSql(tenantId: string, bookingId: string, scope: AgentBookingScope) {
  if (scope.level === 'AGENCY') {
    return Prisma.sql`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} AND "agency_id" = ${scope.agencyId} FOR UPDATE`
  }
  return Prisma.sql`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`
}

/**
 * Resolves booking scope from the authenticated membership. Agency membership wins over operator read.
 * No agency and no operator grant is refused: tenant membership alone is not access to every agency.
 */
export async function resolveAgentBookingScope(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<AgentBookingScope> {
  const membership = await tx.membership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    include: { tenant: true },
  })
  if (!membership || membership.revokedAt || membership.tenantId !== tenantId || membership.tenant.status !== 'ACTIVE') {
    throw new ForbiddenException('Access denied')
  }
  const member = await tx.agencyMember.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { agencyId: true },
  })
  if (member) return { level: 'AGENCY', agencyId: member.agencyId }
  const roles = await tx.userRole.findMany({
    where: { userId, tenantId, role: { tenantId } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  const formal = roles.flatMap((assignment) => assignment.role.permissions.map((item) => item.permission.key))
  if (!membershipGrantsPermission(membership.role, formal, PERMISSIONS.viewBookings)) throw new ForbiddenException('Access denied')
  return { level: 'OPERATOR' }
}
