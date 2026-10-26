import type { MinorString, Paged } from './operations'

/**
 * Bank statement reconciliation (ADR 0093, reconciliation R6).
 * A bank statement (MT940, camt.053 or CSV) is imported once and matched against recorded supplier settlements (money out) and funding receipts
 * (money in). Every difference is an exception a person other than the importer closes. Amounts are integer minor units serialised as strings.
 * Nothing here posts to the ledger, pays anyone or converts a currency; closing an exception is a recorded, audited statement of what was done elsewhere.
 */
export const BANK_IMPORT_FORMATS = ['MT940', 'CAMT053', 'CSV'] as const
export type BankImportFormat = (typeof BANK_IMPORT_FORMATS)[number]

export const BANK_MATCH_TYPE_NAMES = [
  'MATCHED', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DIRECTION_MISMATCH', 'AMBIGUOUS_REFERENCE', 'DUPLICATE_ENTRY', 'DUPLICATE_PAYMENT', 'UNMATCHED_ENTRY', 'EXPECTED_NOT_ON_STATEMENT',
] as const
export type BankMatchTypeName = (typeof BANK_MATCH_TYPE_NAMES)[number]

export const BANK_EXCEPTION_STATUSES = ['OPEN', 'RESOLVED'] as const
export type BankExceptionStatusName = (typeof BANK_EXCEPTION_STATUSES)[number]

/** EXPLAINED: the difference is understood and needs nothing. BANK_CORRECTION_REQUESTED: raised with the bank. INTERNAL_CORRECTION_REQUESTED: our records are to be corrected through their own workflow. */
export const BANK_RESOLUTIONS = ['EXPLAINED', 'BANK_CORRECTION_REQUESTED', 'INTERNAL_CORRECTION_REQUESTED'] as const
export type BankResolution = (typeof BANK_RESOLUTIONS)[number]

/** Largest statement text accepted in one import (characters). */
export const BANK_IMPORT_MAX_CONTENT_CHARS = 1_500_000

export interface BankStatementImportRequest {
  /** Client-generated idempotency key (8 to 80 characters). Retrying returns the same statement. */
  requestId: string
  format: BankImportFormat
  /** The statement file as text. */
  content: string
  /** CSV only: the identity the file does not carry. MT940 and camt.053 state their own. */
  statementRef?: string
  accountId?: string
}

export interface BankStatementView {
  id: string
  format: BankImportFormat
  statementRef: string
  /** Never the full account number. */
  accountLast4: string
  currency: string
  periodStart: string
  periodEnd: string
  openingMinor: MinorString | null
  closingMinor: MinorString | null
  entryCount: number
  importedById: string
  importedAt: string
  matched: number
  exceptions: { open: number; resolved: number }
}

export interface BankMatchSummaryView {
  currency: string
  matched: number
  exceptions: number
  matchedMinor: MinorString
  /** Bank movements nobody expected (the suspense list), by direction. Per currency, never added across currencies. */
  unmatchedCreditMinor: MinorString
  unmatchedDebitMinor: MinorString
}

export interface BankStatementDetail { statement: BankStatementView; summary: BankMatchSummaryView[]; definitions: Record<string, string> }

/** Returned by an import. `replayed` is true when the same requestId (or the same statement content) had already been imported. */
export interface BankStatementImportResult { statement: BankStatementView; summary: BankMatchSummaryView[]; replayed: boolean }

export interface BankExceptionView {
  id: string
  statementId: string
  statementRef: string
  type: BankMatchTypeName
  hint: string
  status: BankExceptionStatusName
  currency: string
  bankMinor: MinorString | null
  expectedMinor: MinorString | null
  /** bank minus expected, same currency only. Null: cannot be computed. */
  varianceMinor: MinorString | null
  entryRef: string | null
  direction: 'CREDIT' | 'DEBIT' | null
  expectedKind: 'SUPPLIER_SETTLEMENT' | 'FUNDING_RECEIPT' | null
  expectedId: string | null
  resolution: BankResolution | null
  resolutionReason: string | null
  resolvedById: string | null
  resolvedAt: string | null
  createdAt: string
  /** For the CALLER: the endpoint still enforces permission and separation of duties. */
  canResolve: boolean
}

export interface BankExceptionResolveRequest { resolution: BankResolution; reason: string }

export type BankExceptionPage = Paged<BankExceptionView>
export type BankStatementPage = Paged<BankStatementView>

/** Write endpoints answer 503 with the same code as supplier reconciliation unless FINANCE_RECONCILIATION_ENABLED=true. Reads always work. */
export const bankReconciliationPermissions = { run: 'finance.reconcile.run', resolve: 'finance.reconcile.resolve' } as const
