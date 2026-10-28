import type { MinorString, Paged } from './operations'

/**
 * Finance period close (ADR 0101). A period is one calendar month in UTC, `[start, end)` on a ledger entry's `immutable_at`. Closing records per-currency control totals
 * (opening + movement = closing) and the integrity verdict, then locks the period: the database refuses a ledger entry dated inside it. A closed period is never reopened;
 * a late correction is posted as a new entry in the open period. Currencies are never added together.
 */
export const PERIOD_BLOCKERS = ['PERIOD_NOT_ENDED', 'PERIOD_ALREADY_CLOSED', 'PERIOD_NOT_NEXT', 'INTEGRITY_ISSUES', 'INTEGRITY_INCOMPLETE'] as const
export type PeriodBlockerName = (typeof PERIOD_BLOCKERS)[number]

export const FINANCE_PERIOD_FAILURE = {
  disabled: 'FINANCE_PERIOD_CLOSE_DISABLED',
  invalid: 'FINANCE_PERIOD_INVALID',
  blocked: 'FINANCE_PERIOD_BLOCKED',
  changed: 'FINANCE_PERIOD_CHANGED',
} as const

export const financePeriodPermissions = { close: 'finance.period.close' } as const

export interface FinancePeriodTypeTotal { type: string; entries: number; sumMinor: MinorString }
export interface FinancePeriodCurrencyTotals {
  currency: string; entries: number
  openingMinor: MinorString; movementMinor: MinorString; closingMinor: MinorString
  byType: FinancePeriodTypeTotal[]
}

/** What closing a month would record, computed now and written nowhere. */
export interface FinancePeriodPreview {
  month: string; periodStart: string; periodEnd: string
  closable: boolean
  blockers: PeriodBlockerName[]
  integrityVerdict: 'CLEAN' | 'WARNINGS' | 'ISSUES' | 'INCOMPLETE'
  integrityCriticalCount: number; integrityWarningCount: number
  totals: FinancePeriodCurrencyTotals[]
  generatedAt: string
}

export interface FinancePeriodCloseRequest {
  /** `YYYY-MM`. */
  month: string
  /** Why or what was reviewed (3 to 500 characters), for example the warnings accepted. Optional. */
  note?: string
}

export interface FinancePeriodView {
  id: string
  month: string; periodStart: string; periodEnd: string
  integrityVerdict: 'CLEAN' | 'WARNINGS'
  warningCount: number
  totals: FinancePeriodCurrencyTotals[]
  /** Newest hash chain link of each wallet at close. Keep a copy outside the database. */
  chainHeads: Array<{ accountId: string; seq: number; entryHash: string }>
  note: string | null
  closedById: string; closedAt: string
}

export type FinancePeriodPage = Paged<FinancePeriodView>
