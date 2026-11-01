import { Injectable } from '@nestjs/common'
import {
  LEDGER_INTEGRITY_ENTRY_LIMIT, LEDGER_INTEGRITY_FINDING_LIMIT, LEDGER_INTEGRITY_STALE_MINUTES_DEFAULT,
  type LedgerIntegrityCurrencyTotals, type LedgerIntegrityFindingView, type LedgerIntegrityReport, type LedgerIntegrityVerdict,
} from '@bedbanks/contracts'
import { bookingLedgerFacts, checkLedgerIntegrity, type ChainBreak, type IntegrityBooking, type IntegrityFinding, type IntegrityReport } from '@bedbanks/money'
import { PrismaService } from '../database/prisma.service'
import { creditLineResolver } from '../agent/agency-account'
import { guardedRead } from './operations-read'
import { intParam } from './query-params'

const CHUNK = 1_000
const chunks = <T>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK))
const minorRecord = (amounts: Record<string, bigint>) => Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, v.toString()]))

const DEFINITIONS: Record<string, string> = {
  scope: 'Every ledger entry and account of the tenant, tied out to the bookings, cancellation records and funding receipts that caused them. Read-only: nothing is posted, corrected or locked.',
  rollForward: 'Per currency: balance = funding credits + other credits + refunds - charges - open reservations + adjustments - reversals. Currencies are never added together.',
  ENTRY_SIGN_INVALID: 'An entry is zero or carries the wrong sign for its kind (CREDIT, RELEASE, REFUND positive; DEBIT, HOLD, REVERSAL negative; ADJUSTMENT either way).',
  ENTRY_CURRENCY_MISMATCH: 'An entry currency differs from its account currency. Amounts are never converted.',
  ENTRY_ACCOUNT_UNKNOWN: 'An entry references an account that is not readable in this tenant.',
  LEDGER_CHAIN_BROKEN: 'The tamper-evident hash chain over this account\'s ledger does not verify: a link or an entry was changed, removed or inserted outside the application (ADR 0094). Treat as a security incident.',
  LEDGER_CHAIN_ENTRY_UNCHAINED: 'A ledger entry has no link in the hash chain. The database writes the link with the entry, so the chain was bypassed or disabled (ADR 0094).',
  ACCOUNT_OVER_CREDIT_LINE: 'Balance is below minus the credit line. Allowed when a limit was lowered after spending (ADR 0024); new spending is refused until it recovers.',
  BOOKING_SPLIT_ACROSS_ACCOUNTS: 'One booking has postings on more than one account.',
  RESERVATION_OVER_RELEASED: 'More was released than was reserved for a booking, for example released and then also settled: the agency holds the stay at no net cost.',
  SETTLEMENT_UNBALANCED: 'The settle-release and the charge of a booking differ; confirmation must post them as an equal pair.',
  CHARGE_WITHOUT_RESERVATION: 'A booking was charged without a reservation (HOLD) ever being authorized.',
  REFUND_EXCEEDS_CHARGE: 'Refunds on a booking exceed what it was charged.',
  RESERVATION_STALE: 'A reservation is older than the stale threshold and was neither released nor settled. Run booking reconciliation.',
  BOOKING_NOT_FOUND: 'The ledger references a booking that does not exist in this tenant.',
  CHARGE_AMOUNT_MISMATCH: 'The reserved or charged amount, or the currency, differs from the booking total.',
  CONFIRMED_NOT_CHARGED: 'A booking in a charged state (confirmed, amended, checked out, no-show) holds a reservation that was never converted into a charge.',
  CHARGED_NOT_CONFIRMED: 'A booking that is not in a charged state carries a charge.',
  RESERVATION_ON_CLOSED_BOOKING: 'A failed, rejected or cancelled booking still holds reserved money, so the agency cannot spend it.',
  CANCELLED_REFUND_NOT_POSTED: 'A charged booking was cancelled without a cancellation record, so no refund was decided or posted (for example an operator or supplier cancellation in booking operations). Finance must decide the refund.',
  REFUND_MISMATCH: 'The refund posted differs from the refund the cancellation record fixed.',
  RECEIPT_NOT_IN_LEDGER: 'A POSTED funding receipt has no matching CREDIT (amount, currency, account and reference).',
  CREDIT_WITHOUT_RECEIPT: 'A funding CREDIT has no POSTED receipt pointing at it.',
  ADJUSTMENT_WITHOUT_APPROVAL: 'An ADJUSTMENT or REVERSAL entry has no approved adjustment record with the same kind, account and amount, so it was posted around the maker-checker flow (ADR 0100).',
  REVERSAL_EXCEEDS_RECEIPT: 'Reversals of one funding receipt add up to more than the receipt paid, or the receipt was never posted: money was taken back that was never received (ADR 0100).',
}

/**
 * Ledger integrity and sub-ledger reconciliation (ADR 0068). One read transaction per call, tenant RLS, permission `finance.read`.
 * The rules live in `@bedbanks/money` (`checkLedgerIntegrity`); this service only loads the records. When the tenant has more entries
 * than the scan limit, it reports INCOMPLETE and no findings rather than a partial verdict that could be wrong in either direction.
 */
@Injectable()
export class OperationsLedgerIntegrityService {
  /** Overridable in tests; never injected. */
  clock: () => Date = () => new Date()

  constructor(private readonly prisma: PrismaService) {}

  /** `db` defaults to the request connection; the scheduled monitor passes its own read-only connection. */
  async report(tenantId: string, query: Record<string, unknown>, db: PrismaService = this.prisma): Promise<LedgerIntegrityReport> {
    const staleReservationMinutes = intParam('staleMinutes', query.staleMinutes, 5, 7 * 24 * 60) ?? LEDGER_INTEGRITY_STALE_MINUTES_DEFAULT
    const now = this.clock()
    return guardedRead(() => db.withTenant(tenantId, async tx => {
      const [wallets, entries, receipts, adjustments] = await Promise.all([
        tx.wallet.findMany({ where: { tenantId }, select: { id: true, agencyId: true, currency: true, creditLimit: true } }),
        tx.ledgerEntry.findMany({ where: { tenantId }, orderBy: [{ immutableAt: 'asc' }, { id: 'asc' }], take: LEDGER_INTEGRITY_ENTRY_LIMIT + 1,
          select: { id: true, walletId: true, type: true, amountMinor: true, currency: true, reference: true, idempotencyKey: true, immutableAt: true } }),
        tx.fundingReceipt.findMany({ where: { tenantId }, select: { id: true, status: true, walletId: true, ledgerEntryId: true, amountMinor: true, currency: true } }),
        tx.ledgerAdjustment.findMany({ where: { tenantId }, select: { id: true, kind: true, status: true, walletId: true, ledgerEntryId: true, amountMinor: true, currency: true, fundingReceiptId: true } }),
      ])
      const capped = entries.length > LEDGER_INTEGRITY_ENTRY_LIMIT
      const scan = { accounts: wallets.length, entries: Math.min(entries.length, LEDGER_INTEGRITY_ENTRY_LIMIT), bookings: 0, receipts: receipts.length, entryLimit: LEDGER_INTEGRITY_ENTRY_LIMIT, capped }
      if (capped) return this.view(now, staleReservationMinutes, scan, null, new Map(), [])

      const [chainBreaks, chainHeads] = await Promise.all([
        tx.$queryRaw<Array<{ wallet_id: string; entry_id: string | null; seq: number | null; reason: ChainBreak['reason'] }>>`SELECT "wallet_id", "entry_id", "seq", "reason" FROM fbeds_ledger_chain_breaks()`,
        tx.$queryRaw<Array<{ wallet_id: string; seq: number; entry_hash: string }>>`SELECT "wallet_id", "seq", "entry_hash" FROM fbeds_ledger_chain_heads() ORDER BY "wallet_id"`,
      ])
      const line = await creditLineResolver(tx, tenantId, wallets)
      const integrityEntries = entries.map(e => ({ id: e.id, accountId: e.walletId, type: e.type, amountMinor: e.amountMinor, currency: e.currency, reference: e.reference, idempotencyKey: e.idempotencyKey, at: e.immutableAt }))
      const bookingIds = [...bookingLedgerFacts(integrityEntries).keys()]
      const bookings: IntegrityBooking[] = []
      for (const ids of chunks(bookingIds)) {
        const [rows, cancellations] = await Promise.all([
          tx.booking.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, status: true, currency: true, totalMinor: true } }),
          tx.cancellation.findMany({ where: { bookingId: { in: ids }, booking: { tenantId } }, select: { bookingId: true, refundMinor: true } }),
        ])
        const refunds = new Map(cancellations.map(c => [c.bookingId, c.refundMinor]))
        for (const b of rows) bookings.push({ id: b.id, status: b.status, currency: b.currency, totalMinor: b.totalMinor, ...(refunds.has(b.id) ? { cancellationRefundMinor: refunds.get(b.id) ?? null } : {}) })
      }
      const report = checkLedgerIntegrity({
        accounts: wallets.map(w => ({ id: w.id, currency: w.currency, agencyId: w.agencyId, creditLineMinor: line(w) })),
        entries: integrityEntries, bookings,
        receipts: receipts.map(r => ({ id: r.id, status: r.status, accountId: r.walletId, ledgerEntryId: r.ledgerEntryId, amountMinor: r.amountMinor, currency: r.currency })),
        adjustments: adjustments.map(a => ({ id: a.id, kind: a.kind, status: a.status, accountId: a.walletId, ledgerEntryId: a.ledgerEntryId, amountMinor: a.amountMinor, currency: a.currency, receiptId: a.fundingReceiptId })),
        chainBreaks: chainBreaks.map(b => ({ accountId: b.wallet_id, entryId: b.entry_id, seq: b.seq, reason: b.reason })),
        now, staleReservationMinutes,
      })
      return this.view(now, staleReservationMinutes, { ...scan, bookings: report.bookingsChecked }, report, new Map(wallets.map(w => [w.id, w.agencyId])), chainHeads.map(h => ({ accountId: h.wallet_id, seq: h.seq, entryHash: h.entry_hash })))
    }))
  }

  private view(now: Date, staleReservationMinutes: number, scan: LedgerIntegrityReport['scan'], report: IntegrityReport | null, agencyOf: Map<string, string | null>, chainHeads: LedgerIntegrityReport['chainHeads']): LedgerIntegrityReport {
    const findings = report?.findings ?? []
    const byCode = new Map<string, { code: string; severity: 'critical' | 'warning'; count: number }>()
    for (const f of findings) { const row = byCode.get(f.code) ?? { code: f.code, severity: f.severity, count: 0 }; row.count += 1; byCode.set(f.code, row) }
    const critical = findings.filter(f => f.severity === 'critical').length
    const verdict: LedgerIntegrityVerdict = !report ? 'INCOMPLETE' : critical > 0 ? 'ISSUES' : findings.length > 0 ? 'WARNINGS' : 'CLEAN'
    const totals: LedgerIntegrityCurrencyTotals[] = (report?.totals ?? []).map(t => ({
      currency: t.currency, accounts: t.accounts, entries: t.entries,
      fundingCreditsMinor: t.fundingCreditsMinor.toString(), otherCreditsMinor: t.otherCreditsMinor.toString(), chargesMinor: t.chargesMinor.toString(), refundsMinor: t.refundsMinor.toString(),
      openReservationsMinor: t.openReservationsMinor.toString(), balanceMinor: t.balanceMinor.toString(),
      adjustmentsMinor: t.adjustmentsMinor.toString(), reversalsMinor: t.reversalsMinor.toString(), postedReceiptsMinor: t.postedReceiptsMinor.toString(),
    }))
    const findingView = (f: IntegrityFinding): LedgerIntegrityFindingView => ({
      code: f.code, severity: f.severity, currency: f.currency, accountId: f.accountId, agencyId: f.accountId ? agencyOf.get(f.accountId) ?? null : null,
      bookingId: f.bookingId, receiptId: f.receiptId, entryId: f.entryId, amounts: minorRecord(f.amounts),
    })
    return {
      generatedAt: now.toISOString(), verdict, staleReservationMinutes, scan,
      counts: { critical, warning: findings.length - critical, byCode: [...byCode.values()].sort((x, y) => (x.severity === y.severity ? x.code.localeCompare(y.code) : x.severity === 'critical' ? -1 : 1)) },
      totals, findings: findings.slice(0, LEDGER_INTEGRITY_FINDING_LIMIT).map(findingView), findingsTruncated: findings.length > LEDGER_INTEGRITY_FINDING_LIMIT, chainHeads,
      definitions: DEFINITIONS,
    }
  }
}
