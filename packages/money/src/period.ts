/**
 * Finance period close rules (ADR 0101). Pure: integer minor units as bigint, no I/O, no framework, no clock of its own. A period is one calendar month in UTC,
 * `[start, end)` on a ledger entry's `immutable_at`. Currencies are never added together; every total is per currency.
 */
export type PeriodBlocker = 'PERIOD_NOT_ENDED' | 'PERIOD_ALREADY_CLOSED' | 'PERIOD_NOT_NEXT' | 'INTEGRITY_ISSUES' | 'INTEGRITY_INCOMPLETE'

export interface PeriodRange { month: string; start: Date; end: Date }

/** A closing run reads the ledger as of now; an entry created by a transaction that began shortly before the cut-off could still be committing, so the month must have ended this long ago. */
export const PERIOD_CLOSE_GRACE_MINUTES = 5

/** `YYYY-MM` to the UTC range `[first of month, first of next month)`. Returns null for anything that is not a real month. */
export function monthRange(month: string): PeriodRange | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!m) return null
  const year = Number(m[1]); const index = Number(m[2]) - 1
  if (year < 2000 || year > 2999) return null
  return { month, start: new Date(Date.UTC(year, index, 1)), end: new Date(Date.UTC(year, index + 1, 1)) }
}

export interface PeriodBlockerInput {
  range: PeriodRange
  now: Date
  alreadyClosed: boolean
  /** End of the latest closed period, or null when none has been closed. */
  lastClosedEnd: Date | null
  /** `immutable_at` of the earliest ledger entry, or null when the ledger is empty. */
  earliestEntryAt: Date | null
  verdict: 'CLEAN' | 'WARNINGS' | 'ISSUES' | 'INCOMPLETE'
}

/**
 * Why a month cannot be closed now. Empty means it can. Periods close in order with no gap: the next one starts where the last ended, and the first one is the month of the
 * earliest entry. A critical integrity finding or an incomplete scan blocks the close; warnings (credit control, timing) do not and are recorded.
 */
export function periodBlockers(i: PeriodBlockerInput): PeriodBlocker[] {
  const out: PeriodBlocker[] = []
  if (i.alreadyClosed) out.push('PERIOD_ALREADY_CLOSED')
  else {
    const expectedStart = i.lastClosedEnd ?? (i.earliestEntryAt ? new Date(Date.UTC(i.earliestEntryAt.getUTCFullYear(), i.earliestEntryAt.getUTCMonth(), 1)) : null)
    if (expectedStart && i.range.start.getTime() !== expectedStart.getTime()) out.push('PERIOD_NOT_NEXT')
  }
  if (i.range.end.getTime() > i.now.getTime() - PERIOD_CLOSE_GRACE_MINUTES * 60_000) out.push('PERIOD_NOT_ENDED')
  if (i.verdict === 'ISSUES') out.push('INTEGRITY_ISSUES')
  if (i.verdict === 'INCOMPLETE') out.push('INTEGRITY_INCOMPLETE')
  return out
}

export interface PeriodGroup { currency: string; type: string; entries: number; sumMinor: bigint }
export interface PeriodBalance { currency: string; sumMinor: bigint }
export interface PeriodTypeTotal { type: string; entries: number; sumMinor: bigint }
export interface PeriodCurrencyTotals { currency: string; entries: number; openingMinor: bigint; movementMinor: bigint; closingMinor: bigint; byType: PeriodTypeTotal[] }

/**
 * Control totals per currency: opening + movement = closing. `movements` are the entries inside the period, `opening` the balance of everything before it and `closing` everything before its
 * end. If the three disagree (an entry appeared or changed between the reads) the function throws instead of returning totals that do not tie.
 */
export function buildPeriodTotals(input: { opening: readonly PeriodBalance[]; movements: readonly PeriodGroup[]; closing: readonly PeriodBalance[] }): PeriodCurrencyTotals[] {
  const rows = new Map<string, PeriodCurrencyTotals>()
  const row = (currency: string) => {
    const r = rows.get(currency) ?? { currency, entries: 0, openingMinor: 0n, movementMinor: 0n, closingMinor: 0n, byType: [] }
    rows.set(currency, r)
    return r
  }
  for (const o of input.opening) row(o.currency).openingMinor += o.sumMinor
  for (const c of input.closing) row(c.currency).closingMinor += c.sumMinor
  for (const g of input.movements) {
    const r = row(g.currency)
    r.entries += g.entries
    r.movementMinor += g.sumMinor
    r.byType.push({ type: g.type, entries: g.entries, sumMinor: g.sumMinor })
  }
  for (const r of rows.values()) {
    if (r.openingMinor + r.movementMinor !== r.closingMinor) throw new Error(`Period totals do not tie for ${r.currency}: opening ${r.openingMinor} + movement ${r.movementMinor} is not closing ${r.closingMinor}`)
    r.byType.sort((a, b) => a.type.localeCompare(b.type))
  }
  return [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}
