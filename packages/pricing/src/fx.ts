import { minorUnitExponent } from '@bedbanks/money';

/**
 * Settlement FX with a buffer and a volatility margin (ADR 0080, proposed). BigInt only.
 *
 * `rateScaled` is quote major units per one base major unit times 10^8. The buyer's rate is the mid rate widened by the
 * buffer (movement until settlement) plus a volatility margin (intraday risk), both in basis points and both against the buyer, so the
 * seller is never short. A stale rate is refused, never silently used. Conversion rounds half up once, on the converted amount.
 * Same arithmetic as `apps/api/src/supply/fx.ts` for margin zero; the API adopts this module in a later slice.
 */
export const FX_RATE_SCALE = 100_000_000n;
export const FX_MAX_TOTAL_MARGIN_BP = 2_500;

export interface FxQuoteWithMargin {
  from: string; to: string; rateScaled: bigint;
  bufferBp: number; volatilityBp: number;
  /** When the mid rate was set, and the longest age tolerated, in milliseconds. */
  asOfMs: number; maxAgeMs: number;
}

function assertBp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}

export function convertWithMargin(amountMinor: bigint, fx: FxQuoteWithMargin, nowMs: number): bigint {
  assertBp('bufferBp', fx.bufferBp);
  assertBp('volatilityBp', fx.volatilityBp);
  if (fx.bufferBp + fx.volatilityBp > FX_MAX_TOTAL_MARGIN_BP) throw new Error('FX buffer plus volatility margin exceeds the allowed maximum');
  if (fx.rateScaled <= 0n) throw new Error('FX rate must be positive');
  if (amountMinor < 0n) throw new Error('Amount must not be negative');
  if (!Number.isSafeInteger(fx.asOfMs) || !Number.isSafeInteger(fx.maxAgeMs) || fx.maxAgeMs < 0) throw new Error('FX freshness window is invalid');
  if (nowMs - fx.asOfMs > fx.maxAgeMs) throw new Error('FX rate is stale');
  if (nowMs < fx.asOfMs) throw new Error('FX rate is dated in the future');
  const fromScale = 10n ** BigInt(minorUnitExponent(fx.from));
  const toScale = 10n ** BigInt(minorUnitExponent(fx.to));
  const numerator = amountMinor * fx.rateScaled * BigInt(10_000 + fx.bufferBp + fx.volatilityBp) * toScale;
  const denominator = FX_RATE_SCALE * 10_000n * fromScale;
  return (numerator + denominator / 2n) / denominator;
}
