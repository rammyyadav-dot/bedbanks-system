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

/** ISO-4217 minor-unit exponents for currencies this platform formats. Unknown codes are rejected. */
const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  AED: 2,
  BHD: 3,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  OMR: 3,
  USD: 2,
};

export function minorUnitExponent(currency: CurrencyCode): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be an ISO-4217 alpha code');
  const exponent = MINOR_UNIT_EXPONENTS[currency];
  if (exponent === undefined) throw new Error('Unsupported currency');
  return exponent;
}

/**
 * Formats an integer minor amount using the currency exponent.
 * The numeric parts are built with integer division so the value is never passed through a binary float.
 */
export function formatMinorUnits(amountMinor: number, currency: CurrencyCode, locale = 'en-GB'): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error('Money must use a safe integer minor amount');
  const exponent = minorUnitExponent(currency);
  const negative = amountMinor < 0;
  const absolute = negative ? -amountMinor : amountMinor;
  let scale = 1;
  for (let step = 0; step < exponent; step += 1) scale *= 10;
  const whole = Math.trunc(absolute / scale);
  const fraction = absolute % scale;
  const groupedWhole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: true }).format(whole);
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).formatToParts(0);
  return parts.map((part) => {
    if (part.type === 'integer') return `${negative ? '-' : ''}${groupedWhole}`;
    if (part.type === 'fraction') return String(fraction).padStart(exponent, '0');
    if (part.type === 'decimal') return exponent === 0 ? '' : part.value;
    return part.value;
  }).join('');
}
