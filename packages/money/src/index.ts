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
  AUD: 2,
  BHD: 3,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  JPY: 0,
  KWD: 3,
  OMR: 3,
  QAR: 2,
  SAR: 2,
  SGD: 2,
  USD: 2,
};

export function minorUnitExponent(currency: CurrencyCode): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be an ISO-4217 alpha code');
  const exponent = MINOR_UNIT_EXPONENTS[currency];
  if (exponent === undefined) throw new Error('Unsupported currency');
  return exponent;
}

const MAJOR_AMOUNT = /^(\d+)(?:\.(\d+))?$/;

/**
 * Converts a major-unit decimal string to integer minor units using the currency exponent.
 * Fraction digits shorter than the exponent are scaled by integer padding. Extra digits are rejected.
 * No binary floating point is used.
 */
export function majorUnitsToMinor(input: string, currency: CurrencyCode): number {
  const exponent = minorUnitExponent(currency);
  const match = MAJOR_AMOUNT.exec(input.trim());
  if (!match) throw new Error('Invalid major-unit amount');
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) throw new Error('Amount exceeds the currency scale');
  const scale = 10n ** BigInt(exponent);
  const minor = BigInt(match[1]) * scale + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds a safe integer');
  return Number(minor);
}

/** Integer minor units back to a major-unit input string. Trailing zero fractions are omitted. */
export function minorUnitsToMajorInput(amountMinor: number, currency: CurrencyCode): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new Error('Money must use a safe integer minor amount');
  const exponent = minorUnitExponent(currency);
  const scale = 10n ** BigInt(exponent);
  const amount = BigInt(amountMinor);
  const whole = amount / scale;
  const fraction = amount % scale;
  if (exponent === 0 || fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(exponent, '0')}`;
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
