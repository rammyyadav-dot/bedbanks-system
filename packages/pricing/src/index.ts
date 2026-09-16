import { money, type Money } from '@bedbanks/money';

export function applyPercentMarkup(net: Money, basisPoints: number): Money {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) throw new Error('Markup basis points must be a non-negative integer');
  return money(net.amountMinor + Math.round((net.amountMinor * basisPoints) / 10_000), net.currency);
}
