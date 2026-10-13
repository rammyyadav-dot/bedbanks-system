/**
 * Pure ledger arithmetic: the one definition of sign rules, balance and available credit (ADR 0062).
 * Integer minor units as bigint, no floating point, no I/O, no framework. Amounts of different currencies are never added.
 */
export type LedgerEntryKind = 'CREDIT' | 'DEBIT' | 'HOLD' | 'RELEASE' | 'REFUND'

/** Direction every entry kind is stored with: money in raises the balance, money out or reserved lowers it. */
export const LEDGER_SIGN: Readonly<Record<LedgerEntryKind, 1n | -1n>> = {
  CREDIT: 1n,
  DEBIT: -1n,
  HOLD: -1n,
  RELEASE: 1n,
  REFUND: 1n,
}

/** Throws unless the stored amount is non-zero and carries the sign its kind requires. */
export function assertLedgerSign(kind: LedgerEntryKind, amountMinor: bigint): void {
  const sign = LEDGER_SIGN[kind]
  if (sign === undefined) throw new Error('Unknown ledger entry kind')
  if (amountMinor === 0n) throw new Error('Ledger amount must be non-zero')
  if ((amountMinor > 0n ? 1n : -1n) !== sign) throw new Error(`Ledger ${kind} must be ${sign === 1n ? 'positive' : 'negative'}`)
}

/** Balance is the sum of the signed entries. `cached_balance` is never authority. */
export function ledgerBalance(amounts: Iterable<bigint>): bigint {
  let sum = 0n
  for (const amount of amounts) sum += amount
  return sum
}

/** What an account may still spend: balance plus credit line, less holds not yet in the ledger. */
export function availableMinor(input: { balanceMinor: bigint; creditLineMinor: bigint; pendingMinor?: bigint }): bigint {
  return input.balanceMinor + input.creditLineMinor - (input.pendingMinor ?? 0n)
}

/** The binding spend test: the amount fits when it does not exceed what is available. */
export function canSpend(input: { balanceMinor: bigint; creditLineMinor: bigint; pendingMinor?: bigint }, amountMinor: bigint): boolean {
  return amountMinor >= 0n && availableMinor(input) >= amountMinor
}

/** An account is overdrawn when its balance has gone below minus its credit line. This should not happen. */
export function isOverdrawn(input: { balanceMinor: bigint; creditLineMinor: bigint }): boolean {
  return availableMinor(input) < 0n
}

/** A refund may be zero but never negative and never above what was charged. */
export function refundWithin(input: { refundMinor: bigint; authorizedRefundableMinor: bigint }): boolean {
  return input.refundMinor >= 0n && input.authorizedRefundableMinor >= 0n && input.refundMinor <= input.authorizedRefundableMinor
}

export interface CurrencyPosition { currency: string; accounts: number; balanceMinor: bigint; creditLineMinor: bigint; availableMinor: bigint; overdrawnAccounts: number }

/** Totals per currency. Each currency is its own row; there is no cross-currency total. */
export function positionsByCurrency(accounts: Iterable<{ currency: string; balanceMinor: bigint; creditLineMinor: bigint }>): CurrencyPosition[] {
  const rows = new Map<string, CurrencyPosition>()
  for (const a of accounts) {
    const row = rows.get(a.currency) ?? { currency: a.currency, accounts: 0, balanceMinor: 0n, creditLineMinor: 0n, availableMinor: 0n, overdrawnAccounts: 0 }
    row.accounts += 1
    row.balanceMinor += a.balanceMinor
    row.creditLineMinor += a.creditLineMinor
    if (isOverdrawn(a)) row.overdrawnAccounts += 1
    rows.set(a.currency, row)
  }
  for (const row of rows.values()) row.availableMinor = availableMinor(row)
  return [...rows.values()].sort((x, y) => x.currency.localeCompare(y.currency))
}
