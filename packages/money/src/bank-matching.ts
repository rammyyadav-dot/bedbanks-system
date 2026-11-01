/**
 * Bank statement matching (ADR 0093): pure matching of parsed bank movements against the payments the system expects to see.
 *
 * Money out of the bank should match a recorded supplier settlement; money in should match a posted or declared funding receipt. Matching is by
 * an exact reference token and then by exact direction, currency and amount; nothing is fuzzy and nothing is converted (ADR 0029). Everything that
 * is not a clean match is a typed finding for a person. This module classifies; it never posts, pays or edits anything.
 */
import type { BankDirection, BankStatementEntry } from './bank-statement'

export type ExpectedPaymentKind = 'SUPPLIER_SETTLEMENT' | 'FUNDING_RECEIPT'

export interface ExpectedPayment {
  id: string
  kind: ExpectedPaymentKind
  /** The bank or transfer reference the payer or payee was told to quote. */
  reference: string
  currency: string
  amountMinor: bigint
  /** From the bank's point of view: a settlement we paid is a DEBIT, a receipt from an agency is a CREDIT. */
  direction: BankDirection
  /** YYYY-MM-DD the payment was made or declared. Only payments inside the statement period can be reported missing. */
  date: string
}

export const BANK_MATCH_TYPES = [
  'MATCHED',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'DIRECTION_MISMATCH',
  'AMBIGUOUS_REFERENCE',
  'DUPLICATE_ENTRY',
  'DUPLICATE_PAYMENT',
  'UNMATCHED_ENTRY',
  'EXPECTED_NOT_ON_STATEMENT',
] as const
export type BankMatchType = (typeof BANK_MATCH_TYPES)[number]

export const isBankException = (type: BankMatchType): boolean => type !== 'MATCHED'

export interface BankMatchFinding {
  /** Stable per statement: `entry:<n>` for a bank movement, `expected:<id>` for a payment missing from the statement. */
  key: string
  type: BankMatchType
  entryRef: string | null
  expectedId: string | null
  expectedKind: ExpectedPaymentKind | null
  currency: string
  bankMinor: bigint | null
  expectedMinor: bigint | null
  /** bank - expected, same currency only. Null when it cannot be computed. */
  varianceMinor: bigint | null
}

export interface BankMatchSummaryRow {
  currency: string
  matched: number
  exceptions: number
  matchedMinor: bigint
  /** Bank movements nobody expected (the suspense list), by direction. */
  unmatchedCreditMinor: bigint
  unmatchedDebitMinor: bigint
}

export interface BankMatchResult { findings: BankMatchFinding[]; summary: BankMatchSummaryRow[] }

/** References shorter than this are never matched by token: too many unrelated movements would carry them. */
export const MIN_REFERENCE_LENGTH = 6
const MAX_WINDOW = 6

const normalise = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Every normalised string a payer's reference could appear as in this movement: each reference whole, and each run of up to six consecutive tokens of the free text. */
function searchKeys(entry: BankStatementEntry): Set<string> {
  const keys = new Set<string>()
  for (const ref of entry.references) { const n = normalise(ref); if (n) keys.add(n) }
  const tokens = entry.remittanceInfo.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t !== '')
  for (let start = 0; start < tokens.length; start += 1) {
    let joined = ''
    for (let len = 0; len < MAX_WINDOW && start + len < tokens.length; len += 1) { joined += tokens[start + len]; keys.add(joined) }
  }
  return keys
}

const fingerprint = (e: BankStatementEntry): string => [e.entryRef, e.valueDate, e.direction, e.currency, e.amountMinor, [...e.references].sort().join('|')].join('\u0000')

/**
 * Matches `entries` against `expected`. Deterministic: findings come in statement order, then missing payments in input order.
 * A payment is consumed by at most one clean match; a second movement carrying the same reference is a DUPLICATE_PAYMENT.
 */
export function matchBankStatement(entries: readonly BankStatementEntry[], expected: readonly ExpectedPayment[], period: { from: string; to: string }, alreadyMatchedIds: ReadonlySet<string> = new Set()): BankMatchResult {
  const byRef = new Map<string, ExpectedPayment[]>()
  for (const payment of expected) {
    const key = normalise(payment.reference)
    if (key.length < MIN_REFERENCE_LENGTH) continue
    const list = byRef.get(key) ?? []
    list.push(payment)
    byRef.set(key, list)
  }

  const findings: BankMatchFinding[] = []
  // Payments an earlier statement already matched count as consumed: a second movement for them is a duplicate payment, and they are never reported missing.
  const consumed = new Set<string>(alreadyMatchedIds)
  const touched = new Set<string>()
  const seen = new Set<string>()

  entries.forEach((entry, index) => {
    const base = { key: `entry:${index + 1}`, entryRef: entry.entryRef, currency: entry.currency, bankMinor: entry.amountMinor }
    const none = { expectedId: null, expectedKind: null, expectedMinor: null, varianceMinor: null }
    const print = fingerprint(entry)
    if (seen.has(print)) { findings.push({ ...base, ...none, type: 'DUPLICATE_ENTRY' }); return }
    seen.add(print)

    const hits = new Map<string, ExpectedPayment>()
    for (const key of searchKeys(entry)) for (const payment of byRef.get(key) ?? []) hits.set(payment.id, payment)
    if (hits.size === 0) { findings.push({ ...base, ...none, type: 'UNMATCHED_ENTRY' }); return }
    if (hits.size > 1) { for (const id of hits.keys()) touched.add(id); findings.push({ ...base, ...none, type: 'AMBIGUOUS_REFERENCE' }); return }

    const payment = [...hits.values()][0]
    touched.add(payment.id)
    const row = { ...base, expectedId: payment.id, expectedKind: payment.kind, expectedMinor: payment.amountMinor }
    if (consumed.has(payment.id)) { findings.push({ ...row, varianceMinor: null, type: 'DUPLICATE_PAYMENT' }); return }
    if (entry.direction !== payment.direction) { findings.push({ ...row, varianceMinor: null, type: 'DIRECTION_MISMATCH' }); return }
    if (entry.currency !== payment.currency) { findings.push({ ...row, varianceMinor: null, type: 'CURRENCY_MISMATCH' }); return }
    const variance = entry.amountMinor - payment.amountMinor
    if (variance !== 0n) { findings.push({ ...row, varianceMinor: variance, type: 'AMOUNT_MISMATCH' }); return }
    consumed.add(payment.id)
    findings.push({ ...row, varianceMinor: 0n, type: 'MATCHED' })
  })

  for (const payment of expected) {
    if (touched.has(payment.id) || consumed.has(payment.id) || payment.date < period.from || payment.date > period.to) continue
    findings.push({ key: `expected:${payment.id}`, type: 'EXPECTED_NOT_ON_STATEMENT', entryRef: null, expectedId: payment.id, expectedKind: payment.kind, currency: payment.currency, bankMinor: null, expectedMinor: payment.amountMinor, varianceMinor: null })
  }

  const rows = new Map<string, BankMatchSummaryRow>()
  const row = (currency: string): BankMatchSummaryRow => {
    const r = rows.get(currency) ?? { currency, matched: 0, exceptions: 0, matchedMinor: 0n, unmatchedCreditMinor: 0n, unmatchedDebitMinor: 0n }
    rows.set(currency, r)
    return r
  }
  findings.forEach((f) => {
    const r = row(f.currency)
    if (f.type === 'MATCHED') { r.matched += 1; r.matchedMinor += f.bankMinor ?? 0n } else r.exceptions += 1
  })
  for (const f of findings) {
    if (f.type !== 'UNMATCHED_ENTRY') continue
    const entry = entries[Number(f.key.slice('entry:'.length)) - 1]
    const r = row(entry.currency)
    if (entry.direction === 'CREDIT') r.unmatchedCreditMinor += entry.amountMinor
    else r.unmatchedDebitMinor += entry.amountMinor
  }
  return { findings, summary: [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency)) }
}
