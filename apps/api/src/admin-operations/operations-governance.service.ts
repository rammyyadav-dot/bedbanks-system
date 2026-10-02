import { Injectable } from '@nestjs/common'
import {
  SUMMARY_WINDOW_DEFAULT_DAYS, SUMMARY_WINDOW_MAX_DAYS, permissionCatalogue,
  type AccessFlag, type AccessReviewPage, type AccessReviewSummary, type AccessReviewUserRow, type ReliabilitySummary, type SummaryWindow,
} from '@bedbanks/contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { DEFAULT_STALE_MINUTES } from '../agent/booking-reconciliation.service'
import { day, iso, guardedRead, sectionRead } from './operations-read'
import { endOfDay, enumParam, intParam, paged, pageParams } from './query-params'
import { OperationsTransactionsService } from './operations-transactions.service'

const DAY_MS = 86_400_000
export const STALE_LOGIN_DAYS = 90
const FLAGS: readonly AccessFlag[] = ['INACTIVE', 'NEVER_LOGGED_IN', 'STALE_LOGIN', 'NO_ROLE', 'HOLDS_SENSITIVE']
/** Enforced S3 permissions: the ones that move bookings and money. */
const SENSITIVE = new Set(permissionCatalogue.filter((p) => p.status === 'enforced' && p.actionClass === 'S3' && !p.approvalOnly).map((p) => p.key))

/**
 * Reliability (platform health from existing operational records) and access review (who holds which authority).
 * Both are read-only and tenant-scoped. Sections the API database role cannot read are explicit unavailable, never zero.
 */
@Injectable()
export class OperationsGovernanceService {
  /** Overridable in tests; never injected. */
  clock: () => Date = () => new Date()

  constructor(private readonly prisma: PrismaService, private readonly tx: OperationsTransactionsService) {}

  private window(query: Record<string, unknown>): SummaryWindow & { start: Date; end: Date } {
    const days = intParam('days', query.days, 1, SUMMARY_WINDOW_MAX_DAYS) ?? SUMMARY_WINDOW_DEFAULT_DAYS
    const now = this.clock()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const start = new Date(today.getTime() - (days - 1) * DAY_MS)
    return { from: day(start), to: day(today), days, start, end: endOfDay(today) }
  }

  // ---- reliability ---------------------------------------------------------------------------------------------------------
  async reliability(tenantId: string, query: Record<string, unknown>): Promise<ReliabilitySummary> {
    const win = this.window(query)
    const staleCutoff = new Date(this.clock().getTime() - DEFAULT_STALE_MINUTES * 60_000)
    const [connectors, executions, supplierOutcomes, holds] = await Promise.all([
      this.tx.connectorSummary(tenantId),
      sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
        const where = { tenantId, createdAt: { gte: win.start, lte: win.end } }
        const [byStatus, failed] = await Promise.all([
          tx.connectorExecution.groupBy({ by: ['status'], where, _count: { _all: true } }),
          tx.connectorExecution.groupBy({ by: ['errorClassification'], where: { ...where, status: 'FAILED' }, _count: { _all: true } }),
        ])
        const n = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0
        return {
          total: byStatus.reduce((sum, x) => sum + x._count._all, 0), succeeded: n('SUCCEEDED'), failed: n('FAILED'), retrying: n('RETRYING'),
          byClassification: failed.map((f) => ({ classification: f.errorClassification ?? 'unclassified', count: f._count._all })).sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification)),
        }
      })),
      sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
        const where = { tenantId, status: { in: ['SENDING', 'UNKNOWN'] as Array<'SENDING' | 'UNKNOWN'> } }
        const [uncertain, oldest] = await Promise.all([tx.supplierMutation.count({ where }), tx.supplierMutation.aggregate({ where, _min: { createdAt: true } })])
        return { uncertain, oldestUncertainAt: iso(oldest._min.createdAt) }
      })),
      sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => ({
        stalledProcessing: await tx.inventoryHold.count({ where: { tenantId, status: 'PROCESSING', updatedAt: { lt: staleCutoff } } }), staleMinutes: DEFAULT_STALE_MINUTES,
      }))),
    ])
    return {
      generatedAt: this.clock().toISOString(), window: { from: win.from, to: win.to, days: win.days },
      definitions: {
        connectors: 'Connector definitions for the tenant. Unhealthy is any health state other than healthy or unknown; unknown means no health observation yet.',
        executions: 'Connector executions created in the window. Counts only; failed executions are grouped by their error classification.',
        supplierOutcomes: 'Supplier calls that are SENDING or UNKNOWN. They may have reached the supplier. Resolve through reconciliation; do not retry blindly.',
        holds: `Inventory holds still PROCESSING after ${DEFAULT_STALE_MINUTES} minutes without an update.`,
      },
      connectors, executions, supplierOutcomes, holds,
    }
  }

  // ---- access review ---------------------------------------------------------------------------------------------------------
  private flagsFor(user: { status: string; lastLoginAt: Date | null }, roleCount: number, sensitive: number, now: Date): AccessFlag[] {
    const flags: AccessFlag[] = []
    if (user.status !== 'ACTIVE') flags.push('INACTIVE')
    if (!user.lastLoginAt) flags.push('NEVER_LOGGED_IN')
    else if (now.getTime() - user.lastLoginAt.getTime() > STALE_LOGIN_DAYS * DAY_MS) flags.push('STALE_LOGIN')
    if (roleCount === 0) flags.push('NO_ROLE')
    if (sensitive > 0) flags.push('HOLDS_SENSITIVE')
    return flags
  }

  /** Members with their roles and effective sensitive permissions, for a tenant. Tenant roles only; platform roles are a separate authority. */
  private async loadMembers(tx: Prisma.TransactionClient, tenantId: string) {
    const [members, roles] = await Promise.all([
      tx.membership.findMany({ where: { tenantId }, select: { role: true, user: { select: { id: true, email: true, name: true, status: true, lastLoginAt: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      tx.role.findMany({ where: { tenantId }, select: { id: true, name: true, users: { select: { userId: true } }, permissions: { select: { permission: { select: { key: true } } } } }, orderBy: { name: 'asc' } }),
    ])
    const rolesOf = new Map<string, Array<{ name: string; sensitive: string[] }>>()
    for (const r of roles) {
      const sensitive = r.permissions.map((p) => p.permission.key).filter((k) => SENSITIVE.has(k)).sort()
      for (const u of r.users) rolesOf.set(u.userId, [...(rolesOf.get(u.userId) ?? []), { name: r.name, sensitive }])
    }
    return { members, roles, rolesOf }
  }

  private rowOf(m: { role: string; user: { id: string; email: string; name: string | null; status: string; lastLoginAt: Date | null } }, rolesOf: Map<string, Array<{ name: string; sensitive: string[] }>>, now: Date): AccessReviewUserRow {
    const rs = rolesOf.get(m.user.id) ?? []
    const sensitive = [...new Set(rs.flatMap((r) => r.sensitive))].sort()
    return {
      userId: m.user.id, email: m.user.email, name: m.user.name, status: m.user.status, membershipRole: m.role, roles: rs.map((r) => r.name).sort(), sensitivePermissions: sensitive,
      lastLoginAt: iso(m.user.lastLoginAt), flags: this.flagsFor(m.user, rs.length, sensitive.length, now),
    }
  }

  async accessReview(tenantId: string): Promise<AccessReviewSummary> {
    const now = this.clock()
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const { members, roles, rolesOf } = await this.loadMembers(tx, tenantId)
      const rows = members.map((m) => this.rowOf(m, rolesOf, now))
      const has = (f: AccessFlag) => rows.filter((r) => r.flags.includes(f)).length
      return {
        generatedAt: now.toISOString(), staleLoginDays: STALE_LOGIN_DAYS,
        definitions: {
          members: 'Users with a membership in this tenant. Platform roles are a separate authority and are not counted here.',
          inactive: 'The user account status is not ACTIVE.',
          neverLoggedIn: 'The user has no recorded login.',
          staleLogin: `The last recorded login is more than ${STALE_LOGIN_DAYS} days ago.`,
          noRole: 'The member holds no tenant role, so has no permission-gated access.',
          holdingSensitive: 'The member holds at least one S3 permission (one that moves bookings or money) through a tenant role.',
        },
        members: { total: rows.length, active: rows.filter((r) => !r.flags.includes('INACTIVE')).length, inactive: has('INACTIVE'), neverLoggedIn: has('NEVER_LOGGED_IN'), staleLogin: has('STALE_LOGIN'), noRole: has('NO_ROLE'), holdingSensitive: has('HOLDS_SENSITIVE') },
        roles: roles.map((r) => ({ id: r.id, name: r.name, members: r.users.length, sensitivePermissions: r.permissions.map((p) => p.permission.key).filter((k) => SENSITIVE.has(k)).sort() })),
      }
    }))
  }

  async accessReviewUsers(tenantId: string, query: Record<string, unknown>): Promise<AccessReviewPage> {
    const page = pageParams(query)
    const flag = enumParam('flag', query.flag, FLAGS)
    const now = this.clock()
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const { members, rolesOf } = await this.loadMembers(tx, tenantId)
      const rows = members.map((m) => this.rowOf(m, rolesOf, now)).filter((r) => !flag || r.flags.includes(flag))
      rows.sort((a, b) => b.flags.length - a.flags.length || a.email.localeCompare(b.email))
      return paged(rows.slice(page.skip, page.skip + page.take), page, rows.length)
    }))
  }
}
