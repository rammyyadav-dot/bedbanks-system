import type { Prisma } from '@prisma/client'
import type { LedgerIntegrityCode, LedgerIntegrityFinding, LedgerIntegrityView } from '@bedbanks/contracts'
import {
  BOOKING_LEDGER_MESSAGES, STALE_AUTHORIZATION_HOURS, evaluateBookingLedger, integrityStatus, isOverdrawn, positionsByCurrency,
  type BookingLedgerFacts,
} from '@bedbanks/money'
import { accountCreditLinesMinor } from '../agent/agency-account'
import { bookingLedgerGroups, ledgerWindowGroups, totalsOf, walletEntryCurrencies, walletTotals, type BookingLedgerGroup } from './ledger-core'

/** Bookings examined per report. A larger ledger is reported as truncated, never silently treated as clean. */
export const INTEGRITY_BOOKING_LIMIT = 20_000
export const INTEGRITY_FINDING_LIMIT = 200
const HOUR_MS = 3_600_000

/**
 * Builds the ledger integrity report (ADR 0063) inside the caller's tenant transaction. Read-only: it posts nothing, repairs nothing and opens
 * no account. The ledger is the only authority; `Wallet.cached_balance` is not read. Shared by the live Admin report and the nightly run
 * (ADR 0064), so the two can never disagree. Run it at REPEATABLE READ so every query sees one consistent snapshot.
 */
export async function buildLedgerIntegrityReport(tx: Prisma.TransactionClient, tenantId: string, now: Date): Promise<LedgerIntegrityView> {
  const [wallets, totals, entryCurrencies, booked, control] = await Promise.all([
    tx.wallet.findMany({ where: { tenantId }, orderBy: [{ currency: 'asc' }, { id: 'asc' }] }),
    walletTotals(tx, tenantId),
    walletEntryCurrencies(tx, tenantId),
    bookingLedgerGroups(tx, tenantId, INTEGRITY_BOOKING_LIMIT),
    ledgerWindowGroups(tx, tenantId, { start: new Date(0), end: now }),
  ])
  const findings: LedgerIntegrityFinding[] = []

  const creditLines = await accountCreditLinesMinor(tx, tenantId, wallets)
  const accounts: Array<{ currency: string; balanceMinor: bigint; creditLineMinor: bigint }> = []
  for (const w of wallets) {
    const balanceMinor = totalsOf(totals, w.id).balanceMinor
    const creditLineMinor = creditLines.get(w.id) ?? 0n
    accounts.push({ currency: w.currency, balanceMinor, creditLineMinor })
    if (isOverdrawn({ balanceMinor, creditLineMinor })) {
      findings.push({ code: 'ACCOUNT_OVERDRAWN', severity: 'ERROR', message: 'The balance is below minus the credit line. Spend should have been refused.', bookingId: null, accountId: w.id, currency: w.currency,
        amountsMinor: { balanceMinor: balanceMinor.toString(), creditLineMinor: creditLineMinor.toString() } })
    }
  }
  const currencyOf = new Map(wallets.map(w => [w.id, w.currency]))
  for (const e of entryCurrencies) {
    const expected = currencyOf.get(e.walletId)
    if (expected !== undefined && expected !== e.currency) {
      findings.push({ code: 'ENTRY_CURRENCY_MISMATCH', severity: 'ERROR', message: `${e.entries} entr${e.entries === 1 ? 'y is' : 'ies are'} in ${e.currency} on a ${expected} account.`, bookingId: null, accountId: e.walletId, currency: e.currency, amountsMinor: {} })
    }
  }

  const byBooking = new Map<string, BookingLedgerGroup[]>()
  for (const g of booked.groups) byBooking.set(g.bookingRef, [...(byBooking.get(g.bookingRef) ?? []), g])
  for (const [ref, groups] of byBooking) {
    const facts = bookingFacts(groups, now)
    for (const f of evaluateBookingLedger(facts)) {
      findings.push({ code: f.code, severity: f.severity, message: BOOKING_LEDGER_MESSAGES[f.code], bookingId: ref.slice('booking:'.length), accountId: null,
        currency: facts.currencies.length === 1 ? facts.currencies[0] : null,
        amountsMinor: { heldMinor: facts.holdMinor.toString(), releasedMinor: facts.releaseMinor.toString(), chargedMinor: facts.debitMinor.toString(), refundedMinor: facts.refundMinor.toString() } })
    }
  }

  const errors = findings.filter(f => f.severity === 'ERROR').length
  const warnings = findings.length - errors
  const byCode = new Map<LedgerIntegrityCode, number>()
  for (const f of findings) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1)
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'ERROR' ? -1 : 1))
  const typesByCurrency = new Map<string, Array<{ type: string; entries: number; sumMinor: string }>>()
  for (const g of control) typesByCurrency.set(g.currency.trim(), [...(typesByCurrency.get(g.currency.trim()) ?? []), { type: g.type, entries: g.entries, sumMinor: g.sumMinor.toString() }])
  const positions = positionsByCurrency(accounts)

  return {
    status: integrityStatus({ errors, warnings }), generatedAt: now.toISOString(),
    scanned: { accounts: wallets.length, bookings: byBooking.size, entries: [...totals.values()].reduce((n, t) => n + t.entryCount, 0) },
    truncated: booked.truncated,
    counts: { errors, warnings, byCode: [...byCode.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)) },
    findings: findings.slice(0, INTEGRITY_FINDING_LIMIT),
    control: positions.map(p => ({
      currency: p.currency, accounts: p.accounts, balanceMinor: p.balanceMinor.toString(), creditLineMinor: p.creditLineMinor.toString(), availableMinor: p.availableMinor.toString(), overdrawnAccounts: p.overdrawnAccounts,
      byType: (typesByCurrency.get(p.currency) ?? []).sort((a, b) => a.type.localeCompare(b.type)),
    })),
    staleAuthorizationHours: STALE_AUTHORIZATION_HOURS,
  }
}

/** Collapses a booking's grouped entries into the facts the rules need. HOLD and DEBIT are stored negative; the facts carry magnitudes. */
export function bookingFacts(groups: BookingLedgerGroup[], now: Date): BookingLedgerFacts {
  const facts: BookingLedgerFacts = { currencies: [...new Set(groups.map(g => g.currency))], holdMinor: 0n, holdCount: 0, releaseMinor: 0n, releaseCount: 0, debitMinor: 0n, debitCount: 0, refundMinor: 0n, refundCount: 0, oldestHoldAgeHours: null }
  for (const g of groups) {
    if (g.type === 'HOLD') { facts.holdMinor += -g.sumMinor; facts.holdCount += g.entries; if (g.oldestAt) facts.oldestHoldAgeHours = Math.floor((now.getTime() - g.oldestAt.getTime()) / HOUR_MS) }
    else if (g.type === 'RELEASE') { facts.releaseMinor += g.sumMinor; facts.releaseCount += g.entries }
    else if (g.type === 'DEBIT') { facts.debitMinor += -g.sumMinor; facts.debitCount += g.entries }
    else if (g.type === 'REFUND') { facts.refundMinor += g.sumMinor; facts.refundCount += g.entries }
  }
  return facts
}
