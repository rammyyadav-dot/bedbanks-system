import { money, type Money } from '@bedbanks/money';

/** Largest markup a rule may carry: 100% (10_000 basis points). A larger value is almost certainly a data-entry error. */
export const MAX_MARKUP_BASIS_POINTS = 10_000;

/**
 * Markup on a net amount, in integer minor units: round half up of `net * basisPoints / 10_000`, computed in BigInt so no
 * floating-point value is ever involved. The net amount must be non-negative.
 */
export function markupMinor(netMinor: bigint, basisPoints: number): bigint {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > MAX_MARKUP_BASIS_POINTS) throw new Error('Markup basis points must be an integer from 0 to 10000');
  if (netMinor < 0n) throw new Error('Net amount must not be negative');
  return (netMinor * BigInt(basisPoints) + 5_000n) / 10_000n;
}

export function applyPercentMarkup(net: Money, basisPoints: number): Money {
  const sell = BigInt(net.amountMinor) + markupMinor(BigInt(net.amountMinor), basisPoints);
  if (sell > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Marked-up amount exceeds the safe integer range');
  return money(Number(sell), net.currency);
}
