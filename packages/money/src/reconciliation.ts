/**
 * Supplier statement reconciliation: pure matching of supplier settlement statement lines against internal ledger items (ADR 0070).
 *
 * Integer minor units as bigint, no I/O, no framework, no clock. Currencies are never converted or added: a statement line whose currency differs
 * from the ledger item is an exception that a person decides, never an adjustment this module computes (ADR 0029: no FX conversion exists).
 * Nothing here posts anything; it classifies. Unknown stays unknown: a ledger item with no recorded net is an exception, never zero.
 */
import { minorUnitExponent } from './index'

export type StatementLineKind = 'CHARGE' | 'CREDIT' | 'SURCHARGE'

/** One supplier statement line. `amountMinor` is a positive magnitude; `kind` gives the direction. */
export interface StatementLineInput {
  lineId: string
  reference: string
  kind: StatementLineKind
  currency: string
  amountMinor: bigint
}

/** One internal booking-level ledger item the supplier is expected to invoice (or, when cancelled, credit). */
export interface LedgerItemInput {
  bookingId: string
  /** Every identifier the supplier might quote: our booking reference, the supplier's own reference. */
  references: readonly string[]
  currency: string
  /** Recorded supplier net cost. Null: unknown. */
  netMinor: bigint | null
  state: 'PAYABLE' | 'CANCELLED'
  /** For a CANCELLED item: the credit the supplier owes us. Null: unknown. */
  expectedCreditMinor: bigint | null
  /** True when an earlier statement already charged this booking. Only then is a missing credit worth an exception: a booking cancelled before it was ever invoiced owes nothing. */
  previouslyInvoiced: boolean
}

export interface ReconcilePolicy {
  /** A same-currency difference up to and including this magnitude is a rounding variance. Zero means exact only. */
  roundingToleranceMinor: bigint
}

export const FINDING_TYPES = [
  'MATCHED',
  'ROUNDING_VARIANCE',
  'AMOUNT_OVERCHARGE',
  'AMOUNT_UNDERCHARGE',
  'CURRENCY_MISMATCH',
  'UNINVOICED_SURCHARGE',
  'UNMATCHED_LINE',
  'AMBIGUOUS_REFERENCE',
  'DUPLICATE_LINE',
  'NET_UNKNOWN',
  'CHARGE_ON_CANCELLED',
  'CREDIT_MATCHED',
  'CREDIT_VARIANCE',
  'CREDIT_WITHOUT_CANCELLATION',
  'CREDIT_AMOUNT_UNKNOWN',
  'MISSING_FROM_STATEMENT',
  'CREDIT_NOT_RECEIVED',
] as const
export type FindingType = (typeof FINDING_TYPES)[number]

/** Types that close by themselves: an exact match needs no person. Everything else is an exception for the dispute queue. */
export const CLEAN_FINDING_TYPES: readonly FindingType[] = ['MATCHED', 'CREDIT_MATCHED']
export const isException = (type: FindingType): boolean => !CLEAN_FINDING_TYPES.includes(type)

export type MatchRule = 'REFERENCE_AND_NET_EXACT' | 'REFERENCE_AND_CREDIT_EXACT' | 'REFERENCE_ONLY' | 'NONE'

export interface Finding {
  /** Stable per statement: the statement line id, or `ledger:<bookingId>:<type>` for a ledger-side finding. */
  key: string
  type: FindingType
  rule: MatchRule
  lineId: string | null
  bookingId: string | null
  currency: string
  statementMinor: bigint | null
  ledgerMinor: bigint | null
  /** statement - ledger, same currency only. Null when it cannot be computed (currency mismatch, unknown amount, no counterpart). */
  varianceMinor: bigint | null
}

export interface SettlementSummary {
  currency: string
  chargesMinor: bigint
  creditsMinor: bigint
  /** charges - credits: what the statement asks us to pay in this currency. */
  statementNetMinor: bigint
  /** Amount on lines that matched cleanly. */
  matchedMinor: bigint
  /** Amount on statement lines that raised an exception. */
  exceptionMinor: bigint
}

export interface ReconcileResult {
  findings: Finding[]
  settlement: SettlementSummary[]
}

/** Case and surrounding whitespace never decide a match; nothing else is normalised (no fuzzy matching). */
export const normaliseReference = (reference: string): string => reference.trim().toUpperCase()

const abs = (value: bigint): bigint => (value < 0n ? -value : value)

function classifyAmount(statement: bigint, ledger: bigint, policy: ReconcilePolicy): { type: FindingType; variance: bigint } {
  const variance = statement - ledger
  if (variance === 0n) return { type: 'MATCHED', variance }
  if (abs(variance) <= policy.roundingToleranceMinor) return { type: 'ROUNDING_VARIANCE', variance }
  return { type: variance > 0n ? 'AMOUNT_OVERCHARGE' : 'AMOUNT_UNDERCHARGE', variance }
}

/**
 * Matches every statement line against the ledger items and reports ledger items the statement does not cover.
 * Deterministic: the same inputs always give the same findings, in statement line order then ledger order.
 */
export function reconcileStatement(lines: readonly StatementLineInput[], items: readonly LedgerItemInput[], policy: ReconcilePolicy): ReconcileResult {
  if (policy.roundingToleranceMinor < 0n) throw new Error('Rounding tolerance must not be negative')
  const byReference = new Map<string, Set<LedgerItemInput>>()
  for (const item of items) {
    for (const reference of item.references) {
      const key = normaliseReference(reference)
      if (!key) continue
      const set = byReference.get(key) ?? new Set<LedgerItemInput>()
      set.add(item)
      byReference.set(key, set)
    }
  }

  const findings: Finding[] = []
  const covered = new Map<string, Set<'CHARGE' | 'CREDIT'>>()
  const seen = new Set<string>()
  const cover = (item: LedgerItemInput, kind: 'CHARGE' | 'CREDIT') => {
    const kinds = covered.get(item.bookingId) ?? new Set<'CHARGE' | 'CREDIT'>()
    kinds.add(kind)
    covered.set(item.bookingId, kinds)
  }

  for (const line of lines) {
    if (line.amountMinor <= 0n) throw new Error('A statement line amount must be a positive magnitude')
    const base = { key: line.lineId, lineId: line.lineId, currency: line.currency, statementMinor: line.amountMinor }
    const emit = (type: FindingType, rule: MatchRule, item: LedgerItemInput | null, ledgerMinor: bigint | null, varianceMinor: bigint | null) =>
      findings.push({ ...base, type, rule, bookingId: item?.bookingId ?? null, ledgerMinor, varianceMinor })

    const identity = `${normaliseReference(line.reference)}\u0000${line.kind}\u0000${line.currency}\u0000${line.amountMinor}`
    if (seen.has(identity)) { emit('DUPLICATE_LINE', 'NONE', null, null, null); continue }
    seen.add(identity)

    const candidates = byReference.get(normaliseReference(line.reference))
    if (!candidates || candidates.size === 0) { emit('UNMATCHED_LINE', 'NONE', null, null, null); continue }
    if (candidates.size > 1) { emit('AMBIGUOUS_REFERENCE', 'NONE', null, null, null); continue }
    const item = [...candidates][0]

    if (line.kind === 'SURCHARGE') {
      // Net rates are all-inclusive (ADR 0029): a supplier surcharge was never part of the contracted net and is never auto-matched.
      emit('UNINVOICED_SURCHARGE', 'REFERENCE_ONLY', item, item.netMinor, null)
      continue
    }

    if (line.kind === 'CHARGE') {
      cover(item, 'CHARGE')
      if (item.state === 'CANCELLED') { emit('CHARGE_ON_CANCELLED', 'REFERENCE_ONLY', item, item.netMinor, null); continue }
      if (item.netMinor === null) { emit('NET_UNKNOWN', 'REFERENCE_ONLY', item, null, null); continue }
      if (item.currency !== line.currency) { emit('CURRENCY_MISMATCH', 'REFERENCE_ONLY', item, item.netMinor, null); continue }
      const { type, variance } = classifyAmount(line.amountMinor, item.netMinor, policy)
      emit(type, type === 'MATCHED' ? 'REFERENCE_AND_NET_EXACT' : 'REFERENCE_ONLY', item, item.netMinor, variance)
      continue
    }

    cover(item, 'CREDIT')
    if (item.state !== 'CANCELLED') { emit('CREDIT_WITHOUT_CANCELLATION', 'REFERENCE_ONLY', item, null, null); continue }
    if (item.expectedCreditMinor === null) { emit('CREDIT_AMOUNT_UNKNOWN', 'REFERENCE_ONLY', item, null, null); continue }
    if (item.currency !== line.currency) { emit('CURRENCY_MISMATCH', 'REFERENCE_ONLY', item, item.expectedCreditMinor, null); continue }
    const { type, variance } = classifyAmount(line.amountMinor, item.expectedCreditMinor, policy)
    if (type === 'MATCHED') emit('CREDIT_MATCHED', 'REFERENCE_AND_CREDIT_EXACT', item, item.expectedCreditMinor, variance)
    else emit('CREDIT_VARIANCE', 'REFERENCE_ONLY', item, item.expectedCreditMinor, variance)
  }

  for (const item of items) {
    const kinds = covered.get(item.bookingId)
    if (item.state === 'PAYABLE' && item.netMinor !== null && !kinds?.has('CHARGE')) {
      findings.push({ key: `ledger:${item.bookingId}:MISSING_FROM_STATEMENT`, type: 'MISSING_FROM_STATEMENT', rule: 'NONE', lineId: null, bookingId: item.bookingId, currency: item.currency, statementMinor: null, ledgerMinor: item.netMinor, varianceMinor: null })
    }
    if (item.state === 'CANCELLED' && item.previouslyInvoiced && item.expectedCreditMinor !== null && item.expectedCreditMinor > 0n && !kinds?.has('CREDIT')) {
      findings.push({ key: `ledger:${item.bookingId}:CREDIT_NOT_RECEIVED`, type: 'CREDIT_NOT_RECEIVED', rule: 'NONE', lineId: null, bookingId: item.bookingId, currency: item.currency, statementMinor: null, ledgerMinor: item.expectedCreditMinor, varianceMinor: null })
    }
  }

  return { findings, settlement: summariseSettlement(lines, findings) }
}

/** Per-currency settlement figures from the statement lines. Currencies are separate rows and never added. */
export function summariseSettlement(lines: readonly StatementLineInput[], findings: readonly Finding[]): SettlementSummary[] {
  const byLine = new Map(findings.filter((f) => f.lineId).map((f) => [f.lineId as string, f]))
  const rows = new Map<string, SettlementSummary>()
  for (const line of lines) {
    const row = rows.get(line.currency) ?? { currency: line.currency, chargesMinor: 0n, creditsMinor: 0n, statementNetMinor: 0n, matchedMinor: 0n, exceptionMinor: 0n }
    if (line.kind === 'CREDIT') row.creditsMinor += line.amountMinor
    else row.chargesMinor += line.amountMinor
    const finding = byLine.get(line.lineId)
    if (finding && isException(finding.type)) row.exceptionMinor += line.amountMinor
    else if (finding) row.matchedMinor += line.amountMinor
    row.statementNetMinor = row.chargesMinor - row.creditsMinor
    rows.set(line.currency, row)
  }
  return [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

/** What a person may decide for each kind of exception. Resolution never posts to the ledger (ADR 0070). */
export type ResolutionAction = 'ACCEPT_STATEMENT' | 'KEEP_LEDGER_AND_DISPUTE' | 'WRITE_OFF_VARIANCE' | 'REJECT_STATEMENT_LINE' | 'ACKNOWLEDGE'

export interface ExceptionRule {
  severity: 'LOW' | 'MEDIUM' | 'HIGH'
  actions: readonly ResolutionAction[]
  /** A one-line cause a finance operator can act on. */
  hint: string
}

export const EXCEPTION_RULES: Readonly<Record<Exclude<FindingType, 'MATCHED' | 'CREDIT_MATCHED'>, ExceptionRule>> = {
  ROUNDING_VARIANCE: { severity: 'LOW', actions: ['WRITE_OFF_VARIANCE', 'KEEP_LEDGER_AND_DISPUTE'], hint: 'Same currency, difference within the rounding tolerance.' },
  AMOUNT_OVERCHARGE: { severity: 'HIGH', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACCEPT_STATEMENT', 'REJECT_STATEMENT_LINE'], hint: 'The supplier charged more than the recorded net.' },
  AMOUNT_UNDERCHARGE: { severity: 'MEDIUM', actions: ['ACCEPT_STATEMENT', 'KEEP_LEDGER_AND_DISPUTE'], hint: 'The supplier charged less than the recorded net.' },
  CURRENCY_MISMATCH: { severity: 'HIGH', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACCEPT_STATEMENT', 'REJECT_STATEMENT_LINE'], hint: 'Statement and booking currencies differ. No conversion is computed; a person decides.' },
  UNINVOICED_SURCHARGE: { severity: 'HIGH', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACCEPT_STATEMENT', 'REJECT_STATEMENT_LINE'], hint: 'A surcharge outside the all-inclusive net. Dispute unless a contract term allows it.' },
  UNMATCHED_LINE: { severity: 'MEDIUM', actions: ['REJECT_STATEMENT_LINE', 'KEEP_LEDGER_AND_DISPUTE'], hint: 'No booking carries this reference.' },
  AMBIGUOUS_REFERENCE: { severity: 'MEDIUM', actions: ['REJECT_STATEMENT_LINE', 'KEEP_LEDGER_AND_DISPUTE'], hint: 'More than one booking carries this reference.' },
  DUPLICATE_LINE: { severity: 'MEDIUM', actions: ['REJECT_STATEMENT_LINE', 'KEEP_LEDGER_AND_DISPUTE'], hint: 'The same reference, kind and amount appears more than once.' },
  NET_UNKNOWN: { severity: 'MEDIUM', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACKNOWLEDGE'], hint: 'The booking has no recorded net, so nothing can be compared. Record the net, then re-run.' },
  CHARGE_ON_CANCELLED: { severity: 'HIGH', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACCEPT_STATEMENT', 'REJECT_STATEMENT_LINE'], hint: 'The supplier charged a cancelled booking.' },
  CREDIT_VARIANCE: { severity: 'MEDIUM', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACCEPT_STATEMENT'], hint: 'The supplier credited a different amount than expected.' },
  CREDIT_WITHOUT_CANCELLATION: { severity: 'MEDIUM', actions: ['REJECT_STATEMENT_LINE', 'KEEP_LEDGER_AND_DISPUTE'], hint: 'A credit for a booking that is not cancelled.' },
  CREDIT_AMOUNT_UNKNOWN: { severity: 'MEDIUM', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACKNOWLEDGE'], hint: 'The expected credit of this cancellation is not recorded.' },
  MISSING_FROM_STATEMENT: { severity: 'LOW', actions: ['ACKNOWLEDGE', 'KEEP_LEDGER_AND_DISPUTE'], hint: 'A payable booking in the statement period that the supplier did not invoice.' },
  CREDIT_NOT_RECEIVED: { severity: 'HIGH', actions: ['KEEP_LEDGER_AND_DISPUTE', 'ACKNOWLEDGE'], hint: 'A cancelled booking the supplier already invoiced, whose expected credit is not on this statement.' },
}

/**
 * Second approval threshold, in whole currency units (so it is meaningful for 0-, 2- and 3-decimal currencies).
 * A decision that accepts, writes off or rejects an amount at or above it needs a second person.
 */
export const SECOND_APPROVAL_MAJOR_UNITS = 100n

export function secondApprovalThresholdMinor(currency: string): bigint {
  return SECOND_APPROVAL_MAJOR_UNITS * 10n ** BigInt(minorUnitExponent(currency))
}

/** The amount a decision puts at stake: the known variance, else the statement amount, else the ledger amount. Null when nothing is known. */
export function amountAtStake(finding: Pick<Finding, 'varianceMinor' | 'statementMinor' | 'ledgerMinor'>): bigint | null {
  if (finding.varianceMinor !== null) return abs(finding.varianceMinor)
  return finding.statementMinor ?? finding.ledgerMinor
}

/**
 * Disputing and acknowledging move no money and need no second person. Accepting or writing off puts the variance at stake; rejecting a line refuses the whole
 * statement amount, so that is what counts. Above the threshold, or with an unknown amount, a second person is needed.
 */
export function needsSecondApproval(action: ResolutionAction, finding: Pick<Finding, 'varianceMinor' | 'statementMinor' | 'ledgerMinor' | 'currency'>): boolean {
  if (action === 'KEEP_LEDGER_AND_DISPUTE' || action === 'ACKNOWLEDGE') return false
  const stake = action === 'REJECT_STATEMENT_LINE' ? (finding.statementMinor ?? finding.ledgerMinor) : amountAtStake(finding)
  return stake === null || stake >= secondApprovalThresholdMinor(finding.currency)
}
