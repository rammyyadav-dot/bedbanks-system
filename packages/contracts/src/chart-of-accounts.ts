import type { MinorString } from './operations'

/**
 * General-ledger chart of accounts and the derived journal (ADR 0102). The agency ledger stays the book of record for agency money; the journal is a balanced double-entry view of one
 * closed month for the accountants, per currency. A ledger movement category maps to a (debit, credit) account pair for a POSITIVE stored amount; a negative one posts the other way round.
 */
export const GL_ACCOUNT_TYPE_NAMES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const
export type GlAccountTypeName = (typeof GL_ACCOUNT_TYPE_NAMES)[number]

export const GL_CATEGORY_NAMES = ['FUNDING_RECEIVED', 'PAYMENT_REVERSAL', 'OTHER_CREDIT', 'COMMISSION_PAYOUT', 'RESERVATION', 'BOOKING_CHARGE', 'BOOKING_REFUND', 'CREDIT_NOTE', 'ADJUSTMENT'] as const
export type GlCategoryName = (typeof GL_CATEGORY_NAMES)[number]

/** Writes answer 503 with FINANCE_CHART_DISABLED unless the deployment sets FINANCE_CHART_ENABLED=true. Reads always work. */
export const GL_CHART_FAILURE = {
  disabled: 'FINANCE_CHART_DISABLED',
  invalid: 'FINANCE_CHART_INVALID',
  notFound: 'FINANCE_CHART_NOT_FOUND',
  duplicateCode: 'FINANCE_CHART_DUPLICATE_CODE',
  inUse: 'FINANCE_CHART_ACCOUNT_IN_USE',
  badMapping: 'FINANCE_CHART_BAD_MAPPING',
  incomplete: 'FINANCE_CHART_INCOMPLETE',
  periodNotClosed: 'FINANCE_CHART_PERIOD_NOT_CLOSED',
  tooLarge: 'FINANCE_CHART_JOURNAL_TOO_LARGE',
  notExportable: 'FINANCE_CHART_JOURNAL_NOT_EXPORTABLE',
} as const

export const glChartPermissions = { manage: 'finance.chart.manage', exportJournal: 'finance.journal.export' } as const

/** `lines` is one row per journal line (a balanced debit and credit); `totals` is one row per currency and account. */
export const GL_JOURNAL_EXPORT_KINDS = ['lines', 'totals'] as const
export type GlJournalExportKind = (typeof GL_JOURNAL_EXPORT_KINDS)[number]

/** Response headers of the export, besides the file itself. */
export const GL_JOURNAL_EXPORT_HEADERS = { sha256: 'X-Journal-Sha256', rows: 'X-Journal-Rows', suspenseEntries: 'X-Journal-Suspense-Entries' } as const

export interface GlAccountView { id: string; code: string; name: string; type: GlAccountTypeName; active: boolean }
export interface GlAccountRefView { id: string; code: string; name: string }
export interface GlMappingView { category: GlCategoryName; description: string; version: number; debit: GlAccountRefView; credit: GlAccountRefView }

export interface GlChartView {
  initialized: boolean
  accounts: GlAccountView[]
  /** The current (highest) version of each category that has one. */
  mappings: GlMappingView[]
  /** Categories with no mapping yet; a journal cannot be built until this is empty. */
  unmappedCategories: GlCategoryName[]
}

export interface GlAccountCreateRequest { code: string; name: string; type: GlAccountTypeName }
export interface GlMappingSetRequest { category: GlCategoryName; debitAccountId: string; creditAccountId: string }

export interface GlJournalLine {
  currency: string; category: GlCategoryName; direction: 'POSITIVE' | 'NEGATIVE'; entries: number
  amountMinor: MinorString
  debit: string; debitName: string; credit: string; creditName: string
}
export interface GlJournalAccountTotal { currency: string; accountCode: string; accountName: string; debitMinor: MinorString; creditMinor: MinorString }

export interface GlJournalView {
  month: string; periodStart: string; periodEnd: string
  /** The mapping version used for each category. The journal is recomputed on every read from the locked month, so a later mapping change changes it. */
  mappingVersions: Record<string, number>
  lines: GlJournalLine[]
  accountTotals: GlJournalAccountTotal[]
  /** Debits equal credits in every currency. */
  balanced: boolean
  /** Entry count and signed sum per currency equal the totals recorded at period close. */
  tiesToClose: boolean
  entries: number
  /** Entries that could not be categorised; the journal then does not cover them. */
  unmappedEntries: number
  /** Entries in the OTHER_CREDIT category (booked to suspense by default): they need classifying. */
  otherCreditEntries: number
  generatedAt: string
}
