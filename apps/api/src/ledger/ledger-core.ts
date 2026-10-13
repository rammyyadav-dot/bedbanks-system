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

export interface BookingLedgerGroup { bookingRef: string; currency: string; type: LedgerEntryType; sumMinor: bigint; entries: number; oldestAt: Date | null }

/**
 * Ledger entries of bookings grouped by booking reference, currency and type. Bounded: at most `limit` groups are read, in reference
 * order, and `truncated` says whether more exist. The reference is `booking:<id>`; other references (funding receipts) are excluded.
 */
export async function bookingLedgerGroups(tx: Prisma.TransactionClient, tenantId: string, limit: number): Promise<{ groups: BookingLedgerGroup[]; truncated: boolean }> {
  const rows = await tx.ledgerEntry.groupBy({
    by: ['reference', 'currency', 'type'], where: { tenantId, reference: { startsWith: 'booking:' } },
    _sum: { amountMinor: true }, _count: { _all: true }, _min: { immutableAt: true },
    orderBy: [{ reference: 'asc' }, { currency: 'asc' }, { type: 'asc' }], take: limit + 1,
  })
  return {
    truncated: rows.length > limit,
    groups: rows.slice(0, limit).map(g => ({ bookingRef: g.reference ?? '', currency: g.currency, type: g.type, sumMinor: g._sum.amountMinor ?? 0n, entries: g._count._all, oldestAt: g._min.immutableAt ?? null })),
  }
}

/** Entry counts per wallet and entry currency, to find entries whose currency differs from their wallet's. */
export async function walletEntryCurrencies(tx: Prisma.TransactionClient, tenantId: string): Promise<Array<{ walletId: string; currency: string; entries: number }>> {
  const rows = await tx.ledgerEntry.groupBy({ by: ['walletId', 'currency'], where: { tenantId }, _count: { _all: true } })
  return rows.map(r => ({ walletId: r.walletId, currency: r.currency, entries: r._count._all }))
}
