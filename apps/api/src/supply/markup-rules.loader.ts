import type { Prisma } from '@prisma/client'
import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'
import type { PrismaService } from '../database/prisma.service'
import type { MarkupRuleRow } from './markup-rules'
import { CommercialControlUnavailableError, controlReadFailure } from './commercial-controls'

const ymd = (value: Date): string => value.toISOString().slice(0, 10)
const SELECT = { scope: true, supplierId: true, hotelId: true, basisPoints: true, validFrom: true, validTo: true } as const
const toRow = (r: { scope: MarkupRuleRow['scope']; supplierId: string | null; hotelId: string | null; basisPoints: number; validFrom: Date; validTo: Date | null }): MarkupRuleRow =>
  ({ scope: r.scope, supplierId: r.supplierId, hotelId: r.hotelId, basisPoints: r.basisPoints, validFrom: ymd(r.validFrom), validTo: r.validTo ? ymd(r.validTo) : null })

const SCOPES = new Set(['TENANT_DEFAULT', 'SUPPLIER', 'HOTEL'])
const validDay = (value: Date | null): boolean => value instanceof Date && !Number.isNaN(value.getTime())

/** A rule must carry the target its scope needs and a sane percentage; anything else is malformed data, not "no rule". */
function assertWellFormed(r: { scope: string; supplierId: string | null; hotelId: string | null; basisPoints: number; validFrom: Date; validTo: Date | null }): void {
  const ok = SCOPES.has(r.scope) && Number.isInteger(r.basisPoints) && r.basisPoints >= 0 && r.basisPoints <= 10_000 && validDay(r.validFrom) && (r.validTo === null || validDay(r.validTo)) &&
    (r.scope !== 'HOTEL' || !!r.hotelId) && (r.scope !== 'SUPPLIER' || !!r.supplierId)
  if (!ok) throw new CommercialControlUnavailableError('markup_rules', 'malformed')
}

/**
 * Loads the tenant's ACTIVE rules in their own transaction (a denied read must not poison the caller's).
 * Valid absence: no ACTIVE rule returns an empty list, and a NET rate then stays unsellable with NET_RATE_MARKUP_UNAVAILABLE (ADR 0018).
 * Failure (ADR 0031): a denied or failed read, or a malformed row, throws `CommercialControlUnavailableError`; it is never an empty list.
 */
export async function loadActiveMarkupRules(prisma: PrismaService, tenantId: string): Promise<MarkupRuleRow[]> {
  let rows: Array<Parameters<typeof toRow>[0]>
  try {
    rows = await prisma.withTenant(tenantId, (tx) => tx.commercialMarkupRule.findMany({ where: { tenantId, status: 'ACTIVE' }, select: SELECT, orderBy: { id: 'asc' } }))
  } catch (error) {
    throw controlReadFailure('markup_rules', error)
  }
  rows.forEach(assertWellFormed)
  return rows.map(toRow)
}

/**
 * The same read inside a caller's transaction, for the Admin readiness views only (never for an offer). A SAVEPOINT keeps a denied read (42501)
 * from aborting the caller's transaction; the view then reports no rules, so NET rates show as not sellable. That is a diagnostic view, not a quote.
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
