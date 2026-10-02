import type { Prisma } from '@prisma/client'
import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'
import type { PrismaService } from '../database/prisma.service'
import type { MarkupRuleRow } from './markup-rules'

const ymd = (value: Date): string => value.toISOString().slice(0, 10)
const SELECT = { scope: true, supplierId: true, hotelId: true, basisPoints: true, validFrom: true, validTo: true } as const
const toRow = (r: { scope: MarkupRuleRow['scope']; supplierId: string | null; hotelId: string | null; basisPoints: number; validFrom: Date; validTo: Date | null }): MarkupRuleRow =>
  ({ scope: r.scope, supplierId: r.supplierId, hotelId: r.hotelId, basisPoints: r.basisPoints, validFrom: ymd(r.validFrom), validTo: r.validTo ? ymd(r.validTo) : null })

/**
 * Loads the tenant's ACTIVE rules in their own transaction (a denied read must not poison the caller's).
 * When the API database role is not allowed to read rules (ADR 0013), the result is no rules, so NET rates stay
 * unsellable with NET_RATE_MARKUP_UNAVAILABLE and `onDenied` lets the caller make that observable. Any other error propagates.
 */
export async function loadActiveMarkupRules(prisma: PrismaService, tenantId: string, onDenied?: () => void): Promise<MarkupRuleRow[]> {
  try {
    const rows = await prisma.withTenant(tenantId, (tx) => tx.commercialMarkupRule.findMany({ where: { tenantId, status: 'ACTIVE' }, select: SELECT, orderBy: { id: 'asc' } }))
    return rows.map(toRow)
  } catch (error) {
    if (isBookingReadDenied(error)) { onDenied?.(); return [] }
    throw error
  }
}

/**
 * The same read inside a caller's transaction. A SAVEPOINT keeps a denied read (42501) from aborting the caller's
 * transaction; the outcome is the same as above: no rules, so NET rates stay unsellable.
 */
export async function loadActiveMarkupRulesInTx(tx: Prisma.TransactionClient, tenantId: string, onDenied?: () => void): Promise<MarkupRuleRow[]> {
  await tx.$executeRawUnsafe('SAVEPOINT markup_rules_read')
  try {
    const rows = await tx.commercialMarkupRule.findMany({ where: { tenantId, status: 'ACTIVE' }, select: SELECT, orderBy: { id: 'asc' } })
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT markup_rules_read')
    return rows.map(toRow)
  } catch (error) {
    if (!isBookingReadDenied(error)) throw error
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT markup_rules_read')
    onDenied?.()
    return []
  }
}
