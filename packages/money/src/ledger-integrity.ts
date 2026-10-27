/**
 * Ledger integrity and sub-ledger reconciliation (ADR 0068). Pure: integer minor units as bigint, no I/O, no framework, no clock.
 * It checks the stored ledger against the rules every posting must keep, and ties the ledger out to the records that caused each
 * posting (bookings, cancellations, funding receipts). Currencies are never added together; every total is per currency.
 *
 * It decides nothing and moves no money. Every finding names the rule, the records and the amounts, so a person can investigate.
 */
import { isLedgerSignValid, type LedgerEntryKind } from './ledger'

export type IntegritySeverity = 'critical' | 'warning'

export type IntegrityCode =
  // entry rules
  | 'ENTRY_SIGN_INVALID' | 'ENTRY_CURRENCY_MISMATCH' | 'ENTRY_ACCOUNT_UNKNOWN'
  // account rules
  | 'ACCOUNT_OVER_CREDIT_LINE'
  // booking ledger lifecycle (HOLD -> RELEASE | RELEASE + DEBIT -> REFUND)
  | 'BOOKING_SPLIT_ACROSS_ACCOUNTS' | 'RESERVATION_OVER_RELEASED' | 'SETTLEMENT_UNBALANCED' | 'CHARGE_WITHOUT_RESERVATION'
  | 'REFUND_EXCEEDS_CHARGE' | 'RESERVATION_STALE'
  // ledger <-> booking sub-ledger
  | 'BOOKING_NOT_FOUND' | 'CHARGE_AMOUNT_MISMATCH' | 'CONFIRMED_NOT_CHARGED' | 'CHARGED_NOT_CONFIRMED' | 'RESERVATION_ON_CLOSED_BOOKING'
  | 'CANCELLED_REFUND_NOT_POSTED' | 'REFUND_MISMATCH'
  // ledger <-> funding receipts
  | 'RECEIPT_NOT_IN_LEDGER' | 'CREDIT_WITHOUT_RECEIPT'
  // ledger <-> adjustments and reversals (ADR 0100): each such entry is an approved, reasoned record; a reversal never takes back more than the receipt paid
  | 'ADJUSTMENT_WITHOUT_APPROVAL' | 'REVERSAL_EXCEEDS_RECEIPT'
  // tamper evidence (ADR 0094): the per-wallet hash chain over the ledger
  | 'LEDGER_CHAIN_BROKEN' | 'LEDGER_CHAIN_ENTRY_UNCHAINED'

export const INTEGRITY_SEVERITY: Readonly<Record<IntegrityCode, IntegritySeverity>> = {
  ENTRY_SIGN_INVALID: 'critical', ENTRY_CURRENCY_MISMATCH: 'critical', ENTRY_ACCOUNT_UNKNOWN: 'critical',
  // A credit line may be lowered below what is already committed (ADR 0024 decision 8), so this is a credit-control warning, not a ledger fault.
  ACCOUNT_OVER_CREDIT_LINE: 'warning',
  BOOKING_SPLIT_ACROSS_ACCOUNTS: 'critical', RESERVATION_OVER_RELEASED: 'critical', SETTLEMENT_UNBALANCED: 'critical', CHARGE_WITHOUT_RESERVATION: 'critical',
  REFUND_EXCEEDS_CHARGE: 'critical', RESERVATION_STALE: 'warning',
  BOOKING_NOT_FOUND: 'critical', CHARGE_AMOUNT_MISMATCH: 'critical', CONFIRMED_NOT_CHARGED: 'critical', CHARGED_NOT_CONFIRMED: 'critical',
  RESERVATION_ON_CLOSED_BOOKING: 'critical', CANCELLED_REFUND_NOT_POSTED: 'critical', REFUND_MISMATCH: 'critical',
  RECEIPT_NOT_IN_LEDGER: 'critical', CREDIT_WITHOUT_RECEIPT: 'critical',
  // An ADJUSTMENT or REVERSAL with no approved record was posted around the maker-checker flow; a reversal above its receipt means money was taken back that was never received.
  ADJUSTMENT_WITHOUT_APPROVAL: 'critical', REVERSAL_EXCEEDS_RECEIPT: 'critical',
  // A broken link means an entry was changed, removed or inserted outside the application. There is no benign cause.
  LEDGER_CHAIN_BROKEN: 'critical', LEDGER_CHAIN_ENTRY_UNCHAINED: 'critical',
}

export interface IntegrityAccount { id: string; currency: string; agencyId: string | null; creditLineMinor: bigint }
export interface IntegrityEntry { id: string; accountId: string; type: LedgerEntryKind; amountMinor: bigint; currency: string; reference: string | null; idempotencyKey: string; at: Date }
/** `cancellationRefundMinor` is the refund the cancellation record fixed; `undefined` when the booking has no cancellation record. */
export interface IntegrityBooking { id: string; status: string; currency: string; totalMinor: bigint; cancellationRefundMinor?: bigint | null }
export interface IntegrityReceipt { id: string; status: string; accountId: string | null; ledgerEntryId: string | null; amountMinor: bigint; currency: string }
/** An ADJUSTMENT or REVERSAL record (ADR 0100). `amountMinor` is the signed amount the ledger entry carries; a REVERSAL names the receipt it takes back. */
export interface IntegrityAdjustment { id: string; kind: 'ADJUSTMENT' | 'REVERSAL'; status: string; accountId: string; ledgerEntryId: string | null; amountMinor: bigint; currency: string; receiptId: string | null }

/** One fault found by the database's chain verifier (`fbeds_ledger_chain_breaks`). `seq` is null for an entry that has no link at all. */
export interface ChainBreak { accountId: string; entryId: string | null; seq: number | null; reason: 'SEQUENCE_GAP' | 'PREV_HASH_MISMATCH' | 'ENTRY_MISSING' | 'ENTRY_HASH_MISMATCH' | 'ENTRY_UNCHAINED' }

export interface IntegrityInput {
  accounts: readonly IntegrityAccount[]
  entries: readonly IntegrityEntry[]
  /** Bookings referenced by the ledger (any not supplied is reported BOOKING_NOT_FOUND) and any other booking worth tying out. */
  bookings: readonly IntegrityBooking[]
  receipts: readonly IntegrityReceipt[]
  /** Adjustment and reversal records. Omit when they were not loaded; the adjustment rules are then not applied. */
  adjustments?: readonly IntegrityAdjustment[]
  /** Faults from the hash chain verifier. Omit when the chain was not checked. */
  chainBreaks?: readonly ChainBreak[]
  now: Date
  /** A reservation older than this with no release or settlement is stale (the reconciliation sweep should have resolved it). */
  staleReservationMinutes: number
}

export interface IntegrityFinding {
  code: IntegrityCode; severity: IntegritySeverity; currency: string | null
  accountId: string | null; bookingId: string | null; receiptId: string | null; entryId: string | null
  /** Named integer minor amounts that show the break, e.g. expectedMinor / actualMinor. */
  amounts: Record<string, bigint>
}

/** Roll-forward per currency: balance = funding + refunds - charges - open reservations + adjustments - reversals (+ any other credits). Each a separate row. */
export interface IntegrityCurrencyTotals {
  currency: string; accounts: number; entries: number
  fundingCreditsMinor: bigint; otherCreditsMinor: bigint; chargesMinor: bigint; refundsMinor: bigint; openReservationsMinor: bigint; balanceMinor: bigint
  /** Signed sum of ADJUSTMENT entries (a debit adjustment is negative). */
  adjustmentsMinor: bigint
  /** Payments taken back, as a positive amount (the entries are stored negative). */
  reversalsMinor: bigint
  /** Funding receipts in POSTED status, from the receipt register; ties to fundingCreditsMinor when the sub-ledger agrees. */
  postedReceiptsMinor: bigint
}

export interface BookingLedgerFacts { bookingId: string; accountIds: Set<string>; currency: string; holdMinor: bigint; releasedMinor: bigint; settleReleaseMinor: bigint; chargeMinor: bigint; refundMinor: bigint; firstHoldAt: Date | null }

export interface IntegrityReport { findings: IntegrityFinding[]; totals: IntegrityCurrencyTotals[]; bookingsChecked: number; receiptsChecked: number }

/** Booking states in which the agency has been (and stays) charged for the stay. */
export const CHARGED_STATES: ReadonlySet<string> = new Set(['CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'CHECKED_OUT', 'NO_SHOW'])
/** Booking states that never produce a charge: a reservation left open on them is money the agency cannot spend. */
export const UNCHARGED_CLOSED_STATES: ReadonlySet<string> = new Set(['FAILED', 'REJECTED'])

const BOOKING_REF = /^booking:(.+)$/
const FUNDING_REF = /^funding:(.+)$/
const bookingIdOf = (reference: string | null) => (reference ? BOOKING_REF.exec(reference)?.[1] ?? null : null)
const abs = (v: bigint) => (v < 0n ? -v : v)

/** Folds the booking postings (keys `booking:<id>:authorize`, `:release`, `:settle-release`, `:settle-debit`, `:cancel-refund`) per booking. */
export function bookingLedgerFacts(entries: readonly IntegrityEntry[]): Map<string, BookingLedgerFacts> {
  const facts = new Map<string, BookingLedgerFacts>()
  for (const e of entries) {
    const bookingId = bookingIdOf(e.reference)
    if (!bookingId) continue
    const f = facts.get(bookingId) ?? { bookingId, accountIds: new Set<string>(), currency: e.currency, holdMinor: 0n, releasedMinor: 0n, settleReleaseMinor: 0n, chargeMinor: 0n, refundMinor: 0n, firstHoldAt: null }
    f.accountIds.add(e.accountId)
    if (e.type === 'HOLD') { f.holdMinor += abs(e.amountMinor); if (!f.firstHoldAt || e.at < f.firstHoldAt) f.firstHoldAt = e.at }
    else if (e.type === 'RELEASE') { if (e.idempotencyKey.endsWith(':settle-release')) f.settleReleaseMinor += e.amountMinor; else f.releasedMinor += e.amountMinor }
    else if (e.type === 'DEBIT') f.chargeMinor += abs(e.amountMinor)
    else if (e.type === 'REFUND') f.refundMinor += e.amountMinor
    facts.set(bookingId, f)
  }
  return facts
}

/** What is still reserved for a booking: held, less what was released or converted into a charge. */
export const openReservationMinor = (f: BookingLedgerFacts) => f.holdMinor - f.releasedMinor - f.settleReleaseMinor

export function checkLedgerIntegrity(input: IntegrityInput): IntegrityReport {
  const findings: IntegrityFinding[] = []
  const add = (code: IntegrityCode, at: Partial<Omit<IntegrityFinding, 'code' | 'severity' | 'amounts'>>, amounts: Record<string, bigint> = {}) =>
    findings.push({ code, severity: INTEGRITY_SEVERITY[code], currency: at.currency ?? null, accountId: at.accountId ?? null, bookingId: at.bookingId ?? null, receiptId: at.receiptId ?? null, entryId: at.entryId ?? null, amounts })

  const accounts = new Map(input.accounts.map(a => [a.id, a]))
  const totals = new Map<string, IntegrityCurrencyTotals>()
  const totalsFor = (currency: string) => {
    const row = totals.get(currency) ?? { currency, accounts: 0, entries: 0, fundingCreditsMinor: 0n, otherCreditsMinor: 0n, chargesMinor: 0n, refundsMinor: 0n, openReservationsMinor: 0n, balanceMinor: 0n, adjustmentsMinor: 0n, reversalsMinor: 0n, postedReceiptsMinor: 0n }
    totals.set(currency, row)
    return row
  }
  for (const a of input.accounts) totalsFor(a.currency).accounts += 1

  // 1. Entry rules and per-account balance.
  const balances = new Map<string, bigint>()
  for (const e of input.entries) {
    const account = accounts.get(e.accountId)
    const at = { currency: e.currency, accountId: e.accountId, entryId: e.id, bookingId: bookingIdOf(e.reference) }
    if (!isLedgerSignValid(e.type, e.amountMinor)) add('ENTRY_SIGN_INVALID', at, { amountMinor: e.amountMinor })
    if (!account) add('ENTRY_ACCOUNT_UNKNOWN', at, { amountMinor: e.amountMinor })
    else if (account.currency !== e.currency) add('ENTRY_CURRENCY_MISMATCH', at, { amountMinor: e.amountMinor })
    balances.set(e.accountId, (balances.get(e.accountId) ?? 0n) + e.amountMinor)
    const row = totalsFor(e.currency)
    row.entries += 1
    row.balanceMinor += e.amountMinor
    if (e.type === 'CREDIT') { if (e.reference && FUNDING_REF.test(e.reference)) row.fundingCreditsMinor += e.amountMinor; else row.otherCreditsMinor += e.amountMinor }
    else if (e.type === 'DEBIT') row.chargesMinor += abs(e.amountMinor)
    else if (e.type === 'REFUND') row.refundsMinor += e.amountMinor
    else if (e.type === 'ADJUSTMENT') row.adjustmentsMinor += e.amountMinor
    else if (e.type === 'REVERSAL') row.reversalsMinor += abs(e.amountMinor)
    // HOLD reserves; every RELEASE (a plain release, or the settle-release that turns the reservation into the DEBIT) returns it.
    else row.openReservationsMinor -= e.amountMinor
  }
  for (const a of input.accounts) {
    const balance = balances.get(a.id) ?? 0n
    if (balance + a.creditLineMinor < 0n) add('ACCOUNT_OVER_CREDIT_LINE', { currency: a.currency, accountId: a.id }, { balanceMinor: balance, creditLineMinor: a.creditLineMinor, overByMinor: -(balance + a.creditLineMinor) })
  }

  // 2. Booking ledger lifecycle, then the tie-out to the booking and cancellation records.
  const facts = bookingLedgerFacts(input.entries)
  const bookings = new Map(input.bookings.map(b => [b.id, b]))
  const staleBefore = input.now.getTime() - input.staleReservationMinutes * 60_000
  for (const f of facts.values()) {
    const at = { currency: f.currency, bookingId: f.bookingId, accountId: f.accountIds.size === 1 ? [...f.accountIds][0] : null }
    const open = openReservationMinor(f)
    if (f.accountIds.size > 1) add('BOOKING_SPLIT_ACROSS_ACCOUNTS', at, { accounts: BigInt(f.accountIds.size) })
    if (open < 0n) add('RESERVATION_OVER_RELEASED', at, { holdMinor: f.holdMinor, releasedMinor: f.releasedMinor, settleReleaseMinor: f.settleReleaseMinor })
    if (f.settleReleaseMinor !== f.chargeMinor) add('SETTLEMENT_UNBALANCED', at, { settleReleaseMinor: f.settleReleaseMinor, chargeMinor: f.chargeMinor })
    if (f.chargeMinor > 0n && f.holdMinor === 0n) add('CHARGE_WITHOUT_RESERVATION', at, { chargeMinor: f.chargeMinor })
    if (f.refundMinor > f.chargeMinor) add('REFUND_EXCEEDS_CHARGE', at, { chargeMinor: f.chargeMinor, refundMinor: f.refundMinor })
    if (open > 0n && f.firstHoldAt && f.firstHoldAt.getTime() < staleBefore) add('RESERVATION_STALE', at, { openReservationMinor: open })

    const b = bookings.get(f.bookingId)
    if (!b) { add('BOOKING_NOT_FOUND', at, { holdMinor: f.holdMinor, chargeMinor: f.chargeMinor, refundMinor: f.refundMinor }); continue }
    if (b.currency !== f.currency || (f.holdMinor > 0n && f.holdMinor !== b.totalMinor) || (f.chargeMinor > 0n && f.chargeMinor !== b.totalMinor)) {
      add('CHARGE_AMOUNT_MISMATCH', at, { bookingTotalMinor: b.totalMinor, holdMinor: f.holdMinor, chargeMinor: f.chargeMinor })
    }
    if (f.holdMinor > 0n && CHARGED_STATES.has(b.status) && f.chargeMinor === 0n) add('CONFIRMED_NOT_CHARGED', at, { bookingTotalMinor: b.totalMinor, openReservationMinor: open })
    if (f.chargeMinor > 0n && !CHARGED_STATES.has(b.status) && b.status !== 'CANCELLED') add('CHARGED_NOT_CONFIRMED', at, { chargeMinor: f.chargeMinor })
    if (open > 0n && (UNCHARGED_CLOSED_STATES.has(b.status) || b.status === 'CANCELLED')) add('RESERVATION_ON_CLOSED_BOOKING', at, { openReservationMinor: open })
    if (b.status === 'CANCELLED' && f.chargeMinor > 0n) {
      if (b.cancellationRefundMinor === undefined) add('CANCELLED_REFUND_NOT_POSTED', at, { chargeMinor: f.chargeMinor, refundMinor: f.refundMinor })
      else if ((b.cancellationRefundMinor ?? 0n) !== f.refundMinor) add('REFUND_MISMATCH', at, { expectedRefundMinor: b.cancellationRefundMinor ?? 0n, refundMinor: f.refundMinor })
    }
  }

  // 3. Funding receipts: every POSTED receipt has exactly its CREDIT, and every funding CREDIT has a POSTED receipt.
  const entriesById = new Map(input.entries.map(e => [e.id, e]))
  const receipts = new Map(input.receipts.map(r => [r.id, r]))
  for (const r of input.receipts) {
    if (r.status !== 'POSTED') continue
    totalsFor(r.currency).postedReceiptsMinor += r.amountMinor
    const e = r.ledgerEntryId ? entriesById.get(r.ledgerEntryId) : undefined
    if (!e || e.type !== 'CREDIT' || e.amountMinor !== r.amountMinor || e.currency !== r.currency || e.accountId !== r.accountId || e.reference !== `funding:${r.id}`) {
      add('RECEIPT_NOT_IN_LEDGER', { currency: r.currency, receiptId: r.id, accountId: r.accountId, entryId: r.ledgerEntryId }, { receiptMinor: r.amountMinor, ledgerMinor: e?.amountMinor ?? 0n })
    }
  }
  for (const e of input.entries) {
    const receiptId = e.type === 'CREDIT' && e.reference ? FUNDING_REF.exec(e.reference)?.[1] : undefined
    if (!receiptId) continue
    const r = receipts.get(receiptId)
    if (!r || r.status !== 'POSTED' || r.ledgerEntryId !== e.id) add('CREDIT_WITHOUT_RECEIPT', { currency: e.currency, accountId: e.accountId, entryId: e.id, receiptId }, { amountMinor: e.amountMinor })
  }

  // 4. Adjustments and reversals: each entry is the one posting of an APPROVED record, and reversals stay within what their receipt paid.
  if (input.adjustments) {
    const approved = new Map<string, IntegrityAdjustment>()
    for (const a of input.adjustments) if (a.status === 'APPROVED' && a.ledgerEntryId) approved.set(a.ledgerEntryId, a)
    const reversedByReceipt = new Map<string, bigint>()
    for (const e of input.entries) {
      if (e.type !== 'ADJUSTMENT' && e.type !== 'REVERSAL') continue
      const a = approved.get(e.id)
      if (!a || a.kind !== e.type || a.accountId !== e.accountId || a.amountMinor !== e.amountMinor || a.currency !== e.currency) {
        add('ADJUSTMENT_WITHOUT_APPROVAL', { currency: e.currency, accountId: e.accountId, entryId: e.id }, { amountMinor: e.amountMinor, recordedMinor: a?.amountMinor ?? 0n })
      } else if (e.type === 'REVERSAL' && a.receiptId) {
        reversedByReceipt.set(a.receiptId, (reversedByReceipt.get(a.receiptId) ?? 0n) + abs(e.amountMinor))
      }
    }
    for (const [receiptId, reversed] of reversedByReceipt) {
      const r = receipts.get(receiptId)
      if (!r || r.status !== 'POSTED' || reversed > r.amountMinor) add('REVERSAL_EXCEEDS_RECEIPT', { currency: r?.currency ?? null, receiptId, accountId: r?.accountId ?? null }, { receiptMinor: r?.amountMinor ?? 0n, reversedMinor: reversed })
    }
  }

  // 5. The hash chain (ADR 0094): the database recomputed every link; each fault is a critical finding on the wallet and entry it names.
  for (const b of input.chainBreaks ?? []) {
    const account = accounts.get(b.accountId)
    add(b.reason === 'ENTRY_UNCHAINED' ? 'LEDGER_CHAIN_ENTRY_UNCHAINED' : 'LEDGER_CHAIN_BROKEN', { currency: account?.currency ?? null, accountId: b.accountId, entryId: b.entryId }, b.seq === null ? {} : { seq: BigInt(b.seq) })
  }

  const order = (f: IntegrityFinding) => (f.severity === 'critical' ? 0 : 1)
  findings.sort((x, y) => order(x) - order(y) || x.code.localeCompare(y.code) || (x.bookingId ?? x.accountId ?? '').localeCompare(y.bookingId ?? y.accountId ?? ''))
  return { findings, totals: [...totals.values()].sort((x, y) => x.currency.localeCompare(y.currency)), bookingsChecked: facts.size, receiptsChecked: input.receipts.length }
}
