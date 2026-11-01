import { BadRequestException } from '@nestjs/common'
import type { LedgerEntryType, Prisma } from '@prisma/client'
import { assertLedgerSign } from '@bedbanks/money'

/**
 * The single transactional ledger layer (ADR 0062). Every append to `LedgerEntry` and every balance read in the API goes through here,
 * so the sign rules, the zero and idempotency-key checks and the balance definition live in one place and cannot drift between the
 * booking, cancellation, funding and reporting paths. All functions take the caller's tenant transaction: they open none, take no lock
 * and post no audit event. Callers keep the wallet row lock and the audit event, which are part of their own business transaction.
 */
export interface LedgerAppend {
  tenantId: string
  walletId: string
  type: LedgerEntryType
  /** Signed stored amount in minor units: CREDIT, RELEASE and REFUND positive; DEBIT and HOLD negative. */
  amountMinor: bigint
  currency: string
  idempotencyKey: string
  reference?: string | null
}

/** Validates an append. Throws a 400 before anything reaches the database. */
export function assertValidAppend(input: LedgerAppend): void {
  if (!input.idempotencyKey.trim()) throw new BadRequestException('Ledger idempotency key is required')
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new BadRequestException('Ledger currency must be an ISO-4217 alpha code')
  try { assertLedgerSign(input.type, input.amountMinor) } catch (error) { throw new BadRequestException((error as Error).message) }
}

/** Appends one entry. The only place that calls `ledgerEntry.create`. */
export function appendLedgerEntry(tx: Prisma.TransactionClient, input: LedgerAppend) {
  assertValidAppend(input)
  return tx.ledgerEntry.create({
    data: {
      tenantId: input.tenantId, walletId: input.walletId, type: input.type, amountMinor: input.amountMinor,
      currency: input.currency, idempotencyKey: input.idempotencyKey, ...(input.reference === undefined ? {} : { reference: input.reference }),
    },
  })
}

/** The balance of one wallet: the sum of its entries, never `cached_balance`. Pass `currency` to also pin the entries' currency. */
export async function walletBalanceMinor(tx: Prisma.TransactionClient, tenantId: string, walletId: string, currency?: string): Promise<bigint> {
  const aggregate = await tx.ledgerEntry.aggregate({ where: { tenantId, walletId, ...(currency === undefined ? {} : { currency }) }, _sum: { amountMinor: true } })
  return aggregate._sum.amountMinor ?? 0n
}

/** The sum of one kind of entry for one business reference on one wallet (for example every REFUND of `booking:<id>`). */
export async function referenceSumMinor(tx: Prisma.TransactionClient, tenantId: string, walletId: string, reference: string, type: LedgerEntryType): Promise<bigint> {
  const aggregate = await tx.ledgerEntry.aggregate({ where: { tenantId, walletId, reference, type }, _sum: { amountMinor: true } })
  return aggregate._sum.amountMinor ?? 0n
}

export interface WalletTotals { balanceMinor: bigint; entryCount: number; lastEntryAt: Date | null }

/** Balances of many wallets in one query. A wallet with no entries is absent from the map; use `totalsOf`. */
export async function walletTotals(tx: Prisma.TransactionClient, tenantId: string, walletIds?: readonly string[]): Promise<Map<string, WalletTotals>> {
  if (walletIds && walletIds.length === 0) return new Map()
  const groups = await tx.ledgerEntry.groupBy({
    by: ['walletId'], where: { tenantId, ...(walletIds ? { walletId: { in: [...walletIds] } } : {}) },
    _sum: { amountMinor: true }, _count: { _all: true }, _max: { immutableAt: true },
  })
  return new Map(groups.map(g => [g.walletId, { balanceMinor: g._sum.amountMinor ?? 0n, entryCount: g._count._all, lastEntryAt: g._max.immutableAt ?? null }]))
}

export const totalsOf = (totals: Map<string, WalletTotals>, walletId: string): WalletTotals => totals.get(walletId) ?? { balanceMinor: 0n, entryCount: 0, lastEntryAt: null }

export interface LedgerWindowGroup { currency: string; type: LedgerEntryType; sumMinor: bigint; entries: number }

/** Entry counts and sums grouped by currency and type inside a window of `immutableAt`. Currencies stay separate rows. */
export async function ledgerWindowGroups(tx: Prisma.TransactionClient, tenantId: string, window: { start: Date; end: Date }): Promise<LedgerWindowGroup[]> {
  const groups = await tx.ledgerEntry.groupBy({
    by: ['currency', 'type'], where: { tenantId, immutableAt: { gte: window.start, lte: window.end } }, _sum: { amountMinor: true }, _count: { _all: true },
  })
  return groups.map(g => ({ currency: g.currency, type: g.type, sumMinor: g._sum.amountMinor ?? 0n, entries: g._count._all }))
}

/** The balance per currency of every entry dated before `before` (exclusive). Currencies stay separate rows. Used by the period close (ADR 0101). */
export async function ledgerBalancesBefore(tx: Prisma.TransactionClient, tenantId: string, before: Date): Promise<Array<{ currency: string; sumMinor: bigint }>> {
  const groups = await tx.ledgerEntry.groupBy({ by: ['currency'], where: { tenantId, immutableAt: { lt: before } }, _sum: { amountMinor: true } })
  return groups.map(g => ({ currency: g.currency, sumMinor: g._sum.amountMinor ?? 0n }))
}

/** Entry counts and sums by currency and type for the half-open range `[start, end)` of `immutableAt`. Used by the period close (ADR 0101). */
export async function ledgerRangeGroups(tx: Prisma.TransactionClient, tenantId: string, range: { start: Date; end: Date }): Promise<LedgerWindowGroup[]> {
  const groups = await tx.ledgerEntry.groupBy({
    by: ['currency', 'type'], where: { tenantId, immutableAt: { gte: range.start, lt: range.end } }, _sum: { amountMinor: true }, _count: { _all: true },
  })
  return groups.map(g => ({ currency: g.currency, type: g.type, sumMinor: g._sum.amountMinor ?? 0n, entries: g._count._all }))
}

/** Hard stop for `foldLedgerRange`: a month with more entries than this is reported as capped rather than folded partially. */
export const LEDGER_FOLD_ENTRY_LIMIT = 500_000

/**
 * Visits every entry dated in the half-open range `[start, end)` in id order, in pages, so a month never has to fit in memory at once. Returns `capped: true` and stops when the limit
 * is reached; the caller must not present a capped fold as complete. Used by the general-ledger journal (ADR 0102).
 */
export async function foldLedgerRange(
  tx: Prisma.TransactionClient, tenantId: string, range: { start: Date; end: Date },
  visit: (entry: { type: string; amountMinor: bigint; currency: string; reference: string | null; idempotencyKey: string }) => void, limit = LEDGER_FOLD_ENTRY_LIMIT,
): Promise<{ capped: boolean }> {
  const PAGE = 2_000
  let seen = 0
  let cursor: string | undefined
  for (;;) {
    const rows = await tx.ledgerEntry.findMany({
      where: { tenantId, immutableAt: { gte: range.start, lt: range.end } }, orderBy: { id: 'asc' }, take: PAGE, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, type: true, amountMinor: true, currency: true, reference: true, idempotencyKey: true },
    })
    for (const r of rows) {
      if (seen >= limit) return { capped: true }
      visit(r)
      seen += 1
    }
    if (rows.length < PAGE) return { capped: false }
    cursor = rows[rows.length - 1].id
  }
}
