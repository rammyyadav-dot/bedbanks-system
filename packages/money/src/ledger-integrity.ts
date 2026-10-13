/**
 * Ledger integrity rules (ADR 0063): what a booking's ledger entries must look like, whatever state the booking is in.
 * Pure integer minor-unit arithmetic as bigint. Amounts here are magnitudes: the HOLD and DEBIT totals are the positive size of the
 * negative stored entries. Nothing here reads a database or decides what to do about a finding; it only names it.
 */
export type IntegritySeverity = 'ERROR' | 'WARNING'

export type BookingLedgerCode =
  | 'MIXED_CURRENCY'
  | 'DUPLICATE_HOLD'
  | 'DUPLICATE_DEBIT'
  | 'DUPLICATE_REFUND'
  | 'RELEASE_EXCEEDS_HOLD'
  | 'SETTLEMENT_MISMATCH'
  | 'REFUND_EXCEEDS_CHARGE'
  | 'STALE_AUTHORIZATION'

export interface BookingLedgerFacts {
  currencies: readonly string[]
  holdMinor: bigint; holdCount: number
  releaseMinor: bigint; releaseCount: number
  debitMinor: bigint; debitCount: number
  refundMinor: bigint; refundCount: number
  /** Age in whole hours of the oldest hold that has not been released or charged; null when there is no hold. */
  oldestHoldAgeHours: number | null
}

export interface BookingLedgerFinding { code: BookingLedgerCode; severity: IntegritySeverity }

/** A hold that is neither released nor charged after this many hours is reported (the prebook sweeper normally closes these sooner). */
export const STALE_AUTHORIZATION_HOURS = 24

export const BOOKING_LEDGER_MESSAGES: Readonly<Record<BookingLedgerCode, string>> = {
  MIXED_CURRENCY: 'Entries for one booking are in more than one currency.',
  DUPLICATE_HOLD: 'More than one hold was posted for this booking.',
  DUPLICATE_DEBIT: 'The booking was charged more than once.',
  DUPLICATE_REFUND: 'The booking was refunded more than once.',
  RELEASE_EXCEEDS_HOLD: 'More was released than was ever held.',
  SETTLEMENT_MISMATCH: 'The charge does not equal the amount released from the hold.',
  REFUND_EXCEEDS_CHARGE: 'The refund is larger than the amount charged.',
  STALE_AUTHORIZATION: `A hold has stayed open for more than ${STALE_AUTHORIZATION_HOURS} hours without a charge or release.`,
}

/** The lifecycle is HOLD, then RELEASE plus DEBIT on confirmation, then at most one REFUND on cancellation. Returns every rule broken. */
export function evaluateBookingLedger(f: BookingLedgerFacts): BookingLedgerFinding[] {
  const out: BookingLedgerFinding[] = []
  const error = (code: BookingLedgerCode) => out.push({ code, severity: 'ERROR' })
  if (f.currencies.length > 1) error('MIXED_CURRENCY')
  if (f.holdCount > 1) error('DUPLICATE_HOLD')
  if (f.debitCount > 1) error('DUPLICATE_DEBIT')
  if (f.refundCount > 1) error('DUPLICATE_REFUND')
  if (f.releaseMinor > f.holdMinor) error('RELEASE_EXCEEDS_HOLD')
  if (f.debitMinor > 0n && f.debitMinor !== f.releaseMinor) error('SETTLEMENT_MISMATCH')
  if (f.refundMinor > f.debitMinor) error('REFUND_EXCEEDS_CHARGE')
  if (f.holdMinor > 0n && f.releaseMinor === 0n && f.debitMinor === 0n && f.oldestHoldAgeHours !== null && f.oldestHoldAgeHours >= STALE_AUTHORIZATION_HOURS) {
    out.push({ code: 'STALE_AUTHORIZATION', severity: 'WARNING' })
  }
  return out
}

/** One verdict for the report: any error fails it, otherwise any warning, otherwise it passes. */
export function integrityStatus(counts: { errors: number; warnings: number }): 'PASS' | 'WARN' | 'FAIL' {
  return counts.errors > 0 ? 'FAIL' : counts.warnings > 0 ? 'WARN' : 'PASS'
}
