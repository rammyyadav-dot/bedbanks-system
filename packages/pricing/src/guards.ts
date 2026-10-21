/**
 * Margin and parity guards (ADR 0080, proposed): pure checks the rate-certification feed can run over priced offers.
 * Percentages are integer basis points; no floating point.
 */

export type GuardSeverity = 'FAIL' | 'WARN';
export interface MarginFloor { minMarginBp: number; minMarginMinor: bigint }

/** Margin in basis points of the sell price, rounded half up: (sell - net) / sell. Null when the sell price is not positive. */
export function marginBp(netMinor: bigint, sellMinor: bigint): number | null {
  if (sellMinor <= 0n) return null;
  return Number(((sellMinor - netMinor) * 10_000n * 2n + sellMinor) / (sellMinor * 2n));
}

export interface MarginFinding { code: 'MARGIN_NEGATIVE' | 'MARGIN_SQUEEZE'; severity: GuardSeverity; marginBp: number | null; marginMinor: bigint }

/**
 * A sell below net is a FAIL (the DMC loses money on every booking). A margin under the floor, in percent or in absolute minor units, is a
 * WARN: it still sells, but a person must decide. Null means the offer is healthy.
 */
export function checkMargin(netMinor: bigint, sellMinor: bigint, floor: MarginFloor): MarginFinding | null {
  const marginMinor = sellMinor - netMinor;
  const bp = marginBp(netMinor, sellMinor);
  if (marginMinor < 0n || bp === null) return { code: 'MARGIN_NEGATIVE', severity: 'FAIL', marginBp: bp, marginMinor };
  if (bp < floor.minMarginBp || marginMinor < floor.minMarginMinor) return { code: 'MARGIN_SQUEEZE', severity: 'WARN', marginBp: bp, marginMinor };
  return null;
}

export interface ChannelPrice { channel: string; sellMinor: bigint }
export interface ParityFinding { code: 'CHANNEL_PARITY_VIOLATION'; severity: GuardSeverity; lowestChannel: string; highestChannel: string; spreadBp: number }

/**
 * Compares the sell price of the same offer (same hotel, room, board, dates, currency) across channels. A spread above the tolerance is a
 * parity violation: the same stay is sold at materially different prices. The spread is measured against the lowest price.
 */
export function checkChannelParity(prices: readonly ChannelPrice[], toleranceBp: number): ParityFinding | null {
  if (!Number.isSafeInteger(toleranceBp) || toleranceBp < 0) throw new Error('Tolerance must be a non-negative integer');
  if (prices.length < 2) return null;
  if (prices.some((p) => p.sellMinor <= 0n)) throw new Error('Channel prices must be positive');
  const sorted = [...prices].sort((a, b) => (a.sellMinor < b.sellMinor ? -1 : a.sellMinor > b.sellMinor ? 1 : a.channel.localeCompare(b.channel)));
  const low = sorted[0]!;
  const high = sorted[sorted.length - 1]!;
  const spreadBp = Number(((high.sellMinor - low.sellMinor) * 10_000n * 2n + low.sellMinor) / (low.sellMinor * 2n));
  return spreadBp > toleranceBp ? { code: 'CHANNEL_PARITY_VIOLATION', severity: 'FAIL', lowestChannel: low.channel, highestChannel: high.channel, spreadBp } : null;
}
