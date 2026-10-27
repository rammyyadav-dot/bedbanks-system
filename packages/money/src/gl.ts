/**
 * General-ledger chart and journal rules (ADR 0102). Pure: integer minor units as bigint, no I/O, no framework, no clock. The agency ledger is the book of record for agency money;
 * this derives a balanced double-entry journal from it for the accountants. Currencies are never converted or added together; every journal is per currency.
 *
 * Convention: each movement category maps to a (debit, credit) account pair for a POSITIVE stored amount. A negative stored amount posts the same pair the other way round.
 * Positive and negative amounts of a category are kept as separate gross rows, so a reservation and its release both show.
 */
export const GL_ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const
export type GlAccountType = (typeof GL_ACCOUNT_TYPES)[number]

export const GL_CATEGORIES = ['FUNDING_RECEIVED', 'PAYMENT_REVERSAL', 'OTHER_CREDIT', 'COMMISSION_PAYOUT', 'RESERVATION', 'BOOKING_CHARGE', 'BOOKING_REFUND', 'CREDIT_NOTE', 'ADJUSTMENT'] as const
export type GlCategory = (typeof GL_CATEGORIES)[number]

export interface GlLedgerEntry { type: string; amountMinor: bigint; currency: string; reference: string | null; idempotencyKey: string }

/** The category of a ledger entry, from what the posting code writes: its kind, reference and idempotency key. Anything not recognised is OTHER_CREDIT (a credit) or null (not mappable). */
export function classifyEntry(e: GlLedgerEntry): GlCategory | null {
  switch (e.type) {
    case 'CREDIT':
      if (e.reference?.startsWith('funding:')) return 'FUNDING_RECEIVED'
      if (e.idempotencyKey.includes(':commission-payout:')) return 'COMMISSION_PAYOUT'
      return 'OTHER_CREDIT'
    case 'REVERSAL': return 'PAYMENT_REVERSAL'
    case 'HOLD': case 'RELEASE': return 'RESERVATION'
    case 'DEBIT': return 'BOOKING_CHARGE'
    case 'REFUND': return e.idempotencyKey.includes(':credit-note:') ? 'CREDIT_NOTE' : 'BOOKING_REFUND'
    case 'ADJUSTMENT': return 'ADJUSTMENT'
    default: return null
  }
}

export interface GlAccountTemplate { code: string; name: string; type: GlAccountType }
export interface GlMappingTemplate { category: GlCategory; debit: string; credit: string }

/**
 * The default chart for a bedbank, as a starting point for the accountants to review. The agency ledger balance is a liability of the bedbank to the agency (a negative balance is a
 * receivable, shown net on the same account). Revenue recognition and supplier cost are not derived from the agency ledger and have no accounts here.
 */
export const DEFAULT_GL_ACCOUNTS: readonly GlAccountTemplate[] = [
  { code: '1000', name: 'Bank', type: 'ASSET' },
  { code: '1900', name: 'Unclassified ledger movements (suspense)', type: 'ASSET' },
  { code: '2100', name: 'Agency account balances', type: 'LIABILITY' },
  { code: '2110', name: 'Agency reservations in progress', type: 'LIABILITY' },
  { code: '2200', name: 'Booking proceeds not yet earned', type: 'LIABILITY' },
  { code: '6100', name: 'Agency commission', type: 'EXPENSE' },
  { code: '6200', name: 'Credit notes and goodwill', type: 'EXPENSE' },
  { code: '6900', name: 'Agency account adjustments', type: 'EXPENSE' },
]

export const DEFAULT_GL_MAPPINGS: readonly GlMappingTemplate[] = [
  { category: 'FUNDING_RECEIVED', debit: '1000', credit: '2100' },
  { category: 'PAYMENT_REVERSAL', debit: '1000', credit: '2100' },
  { category: 'OTHER_CREDIT', debit: '1900', credit: '2100' },
  { category: 'COMMISSION_PAYOUT', debit: '6100', credit: '2100' },
  { category: 'RESERVATION', debit: '2110', credit: '2100' },
  { category: 'BOOKING_CHARGE', debit: '2200', credit: '2100' },
  { category: 'BOOKING_REFUND', debit: '2200', credit: '2100' },
  { category: 'CREDIT_NOTE', debit: '6200', credit: '2100' },
  { category: 'ADJUSTMENT', debit: '6900', credit: '2100' },
]

export const GL_CATEGORY_DESCRIPTIONS: Readonly<Record<GlCategory, string>> = {
  FUNDING_RECEIVED: 'A posted funding receipt: money received from an agency (positive).',
  PAYMENT_REVERSAL: 'A received payment taken back: bank recall, chargeback, duplicate (negative).',
  OTHER_CREDIT: 'A credit that is not a funding receipt or a commission payout. Should be empty; anything here needs classifying.',
  COMMISSION_PAYOUT: 'A commission payout credited to an agency account (positive).',
  RESERVATION: 'Money reserved for a booking being made (negative) and returned or converted into a charge (positive).',
  BOOKING_CHARGE: 'The final charge for a confirmed booking (negative).',
  BOOKING_REFUND: 'Part of a charge returned on cancellation (positive).',
  CREDIT_NOTE: 'A partial credit note on a charged booking (positive).',
  ADJUSTMENT: 'A reasoned correction on an account, either direction.',
}

export interface GlAccountRef { code: string; name: string; type: GlAccountType }
export type GlMapping = Readonly<Record<GlCategory, { debit: GlAccountRef; credit: GlAccountRef }>>

/** Gross sums per currency and category, folded from ledger entries. */
export interface GlCategoryGroup { currency: string; category: GlCategory; positiveMinor: bigint; positiveCount: number; negativeMinor: bigint; negativeCount: number }

export class GlFold {
  private readonly groups = new Map<string, GlCategoryGroup>()
  /** Entries of a kind the chart cannot map; the journal is then incomplete and must say so. */
  unmapped = 0
  entries = 0
  /** Signed sum per currency, to tie to the period close totals. */
  readonly netByCurrency = new Map<string, bigint>()

  add(e: GlLedgerEntry): void {
    this.entries += 1
    this.netByCurrency.set(e.currency, (this.netByCurrency.get(e.currency) ?? 0n) + e.amountMinor)
    const category = classifyEntry(e)
    if (!category || e.amountMinor === 0n) { this.unmapped += 1; return }
    const key = `${e.currency}|${category}`
    const g = this.groups.get(key) ?? { currency: e.currency, category, positiveMinor: 0n, positiveCount: 0, negativeMinor: 0n, negativeCount: 0 }
    if (e.amountMinor > 0n) { g.positiveMinor += e.amountMinor; g.positiveCount += 1 } else { g.negativeMinor += -e.amountMinor; g.negativeCount += 1 }
    this.groups.set(key, g)
  }

  result(): GlCategoryGroup[] { return [...this.groups.values()] }
}

export interface JournalLine { currency: string; category: GlCategory; direction: 'POSITIVE' | 'NEGATIVE'; entries: number; amountMinor: bigint; debit: GlAccountRef; credit: GlAccountRef }
export interface JournalAccountTotal { currency: string; account: GlAccountRef; debitMinor: bigint; creditMinor: bigint }
export interface Journal { lines: JournalLine[]; accountTotals: JournalAccountTotal[]; balanced: boolean }

/** One journal line per currency, category and direction. A positive stored amount debits the mapping's debit account and credits its credit account; a negative one does the reverse. */
export function buildJournal(groups: readonly GlCategoryGroup[], mapping: GlMapping): Journal {
  const lines: JournalLine[] = []
  for (const g of groups) {
    const m = mapping[g.category]
    if (g.positiveMinor > 0n) lines.push({ currency: g.currency, category: g.category, direction: 'POSITIVE', entries: g.positiveCount, amountMinor: g.positiveMinor, debit: m.debit, credit: m.credit })
    if (g.negativeMinor > 0n) lines.push({ currency: g.currency, category: g.category, direction: 'NEGATIVE', entries: g.negativeCount, amountMinor: g.negativeMinor, debit: m.credit, credit: m.debit })
  }
  lines.sort((a, b) => a.currency.localeCompare(b.currency) || a.category.localeCompare(b.category) || a.direction.localeCompare(b.direction))
  const totals = new Map<string, JournalAccountTotal>()
  const bump = (currency: string, account: GlAccountRef, side: 'debitMinor' | 'creditMinor', amount: bigint) => {
    const key = `${currency}|${account.code}`
    const t = totals.get(key) ?? { currency, account, debitMinor: 0n, creditMinor: 0n }
    t[side] += amount
    totals.set(key, t)
  }
  for (const l of lines) { bump(l.currency, l.debit, 'debitMinor', l.amountMinor); bump(l.currency, l.credit, 'creditMinor', l.amountMinor) }
  const accountTotals = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.account.code.localeCompare(b.account.code))
  const debit = new Map<string, bigint>(); const credit = new Map<string, bigint>()
  for (const t of accountTotals) { debit.set(t.currency, (debit.get(t.currency) ?? 0n) + t.debitMinor); credit.set(t.currency, (credit.get(t.currency) ?? 0n) + t.creditMinor) }
  const balanced = [...new Set([...debit.keys(), ...credit.keys()])].every(c => (debit.get(c) ?? 0n) === (credit.get(c) ?? 0n))
  return { lines, accountTotals, balanced }
}

/** Why a proposed mapping is refused, or null. A pair must be two different accounts. */
export function mappingProblem(debit: GlAccountRef | undefined, credit: GlAccountRef | undefined): string | null {
  if (!debit || !credit) return 'Both accounts must exist and be active'
  if (debit.code === credit.code) return 'The debit and credit accounts must differ'
  return null
}
