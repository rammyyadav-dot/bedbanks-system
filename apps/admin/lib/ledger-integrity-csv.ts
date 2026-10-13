import type { LedgerIntegrityView } from '@bedbanks/contracts'

/** A spreadsheet runs a cell that starts with one of these as a formula, so such cells are neutralized with a leading apostrophe. */
const FORMULA_START = /^[=+\-@\t\r]/

/** Our own integer amounts, which may be negative (an overdrawn balance). They are numbers, not formulas, and must stay numbers. */
const PLAIN_INTEGER = /^-?\d+$/

export const csvCell = (value: string | null | undefined): string => {
  let text = value ?? ''
  if (!PLAIN_INTEGER.test(text) && FORMULA_START.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The report as CSV for accountants and auditors. Amounts stay integer minor units beside their currency (no rounding, no conversion),
 * and every figure is exactly what the screen shows. No guest or agency personal data is in the report, so none is in the file.
 */
export function ledgerIntegrityCsv(view: LedgerIntegrityView): string {
  const rows: string[][] = [
    ['generated_at', 'status', 'errors', 'warnings', 'truncated'],
    [view.generatedAt, view.status, String(view.counts.errors), String(view.counts.warnings), String(view.truncated)],
    [],
    ['currency', 'accounts', 'balance_minor', 'credit_lines_minor', 'available_minor', 'overdrawn_accounts'],
    ...view.control.map(c => [c.currency, String(c.accounts), c.balanceMinor, c.creditLineMinor, c.availableMinor, String(c.overdrawnAccounts)]),
    [],
    ['severity', 'code', 'booking_id', 'account_id', 'currency', 'held_minor', 'released_minor', 'charged_minor', 'refunded_minor', 'message'],
    ...view.findings.map(f => [f.severity, f.code, f.bookingId ?? '', f.accountId ?? '', f.currency ?? '',
      f.amountsMinor.heldMinor ?? '', f.amountsMinor.releasedMinor ?? '', f.amountsMinor.chargedMinor ?? '', f.amountsMinor.refundedMinor ?? '', f.message]),
  ]
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

export const ledgerIntegrityFilename = (view: LedgerIntegrityView): string => `ledger-integrity-${view.generatedAt.slice(0, 10)}.csv`
