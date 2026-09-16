export type CurrencyCode = string;
export interface Money { amountMinor: number; currency: CurrencyCode }

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('Money must use a safe integer minor amount');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be an ISO-4217 alpha code');
  return { amountMinor, currency };
}

export function add(left: Money, right: Money): Money {
  if (left.currency !== right.currency) throw new Error('Cannot add different currencies');
  return money(left.amountMinor + right.amountMinor, left.currency);
}
