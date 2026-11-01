/**
 * CSV export of the general-ledger journal (ADR 0103). Pure: integer minor units as bigint, no I/O, no framework, no clock. Amounts are written exactly, as a decimal in major units
 * (from the currency exponent, never through a float) and as integer minor units. Every cell is formula-safe so a spreadsheet cannot execute text that came from a name or note.
 */
import { minorUnitExponent } from './index'

/** Integer minor units to a plain decimal string in major units with exactly the currency's number of fraction digits. */
export function minorToMajorString(amountMinor: bigint, currency: string): string {
  const exponent = minorUnitExponent(currency)
  const negative = amountMinor < 0n
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(exponent + 1, '0')
  const whole = exponent === 0 ? digits : digits.slice(0, digits.length - exponent)
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`
  return `${negative ? '-' : ''}${whole}${fraction}`
}

/** One CSV cell. Text starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe; a cell with a quote, comma or line break is quoted. */
export function csvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export interface ExportJournalLine { currency: string; category: string; direction: string; entries: number; amountMinor: string; debit: string; debitName: string; credit: string; creditName: string }
export interface ExportAccountTotal { currency: string; accountCode: string; accountName: string; debitMinor: string; creditMinor: string }

const file = (rows: readonly (readonly unknown[])[]) => '﻿' + rows.map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n'

export const JOURNAL_LINES_COLUMNS = ['month', 'currency', 'line', 'category', 'direction', 'entries', 'debit_account', 'debit_account_name', 'credit_account', 'credit_account_name', 'amount', 'amount_minor', 'mapping_version'] as const
export const JOURNAL_TOTALS_COLUMNS = ['month', 'currency', 'account', 'account_name', 'debit', 'credit', 'debit_minor', 'credit_minor'] as const

/** One row per journal line: each is a balanced debit and credit of the same amount. `line` counts from 1 within a currency. */
export function journalLinesCsv(month: string, lines: readonly ExportJournalLine[], mappingVersions: Readonly<Record<string, number>>): string {
  const counters = new Map<string, number>()
  return file([[...JOURNAL_LINES_COLUMNS], ...lines.map(l => {
    const n = (counters.get(l.currency) ?? 0) + 1
    counters.set(l.currency, n)
    return [month, l.currency, n, l.category, l.direction, l.entries, l.debit, l.debitName, l.credit, l.creditName, minorToMajorString(BigInt(l.amountMinor), l.currency), l.amountMinor, mappingVersions[l.category] ?? '']
  })])
}

/** One row per currency and account with its debit and credit totals for the month. */
export function journalTotalsCsv(month: string, totals: readonly ExportAccountTotal[]): string {
  return file([[...JOURNAL_TOTALS_COLUMNS], ...totals.map(t => [month, t.currency, t.accountCode, t.accountName, minorToMajorString(BigInt(t.debitMinor), t.currency), minorToMajorString(BigInt(t.creditMinor), t.currency), t.debitMinor, t.creditMinor])])
}
