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

/**
 * Corridor policy (business decision 2026-10-21). Stable majors carry a 30 to 50 bp volatility margin and a 4 hour rate age; corridors with an
 * emerging currency carry 100 to 150 bp and a 1 hour age. A rate older than `hardExpireMs` (12 hours) is expired. There is deliberately NO
 * fallback to a cached rate here: serving a stale price needs an explicit policy (CLAUDE.md invariant 5), so an expired or stale rate is refused.
 */
export const FX_STABLE_MAJORS: readonly string[] = ['USD', 'AED', 'EUR', 'GBP'];
const HOUR_MS = 3_600_000;
export interface FxCorridorPolicy { corridor: 'STABLE' | 'EMERGING'; minVolatilityBp: number; maxVolatilityBp: number; maxAgeMs: number; hardExpireMs: number }

export function fxCorridorPolicy(from: string, to: string): FxCorridorPolicy {
  const stable = FX_STABLE_MAJORS.includes(from) && FX_STABLE_MAJORS.includes(to);
  return stable
    ? { corridor: 'STABLE', minVolatilityBp: 30, maxVolatilityBp: 50, maxAgeMs: 4 * HOUR_MS, hardExpireMs: 12 * HOUR_MS }
    : { corridor: 'EMERGING', minVolatilityBp: 100, maxVolatilityBp: 150, maxAgeMs: 1 * HOUR_MS, hardExpireMs: 12 * HOUR_MS };
}

export type FxRateFreshness = 'FRESH' | 'STALE' | 'EXPIRED';
/** FRESH within the corridor age, STALE past it (refused for new quotes), EXPIRED past the hard limit (refused everywhere, needs a new rate). */
export function fxRateFreshness(policy: FxCorridorPolicy, asOfMs: number, nowMs: number): FxRateFreshness {
  const age = nowMs - asOfMs;
  return age > policy.hardExpireMs ? 'EXPIRED' : age > policy.maxAgeMs ? 'STALE' : 'FRESH';
}

/** Null when the volatility margin sits inside the corridor's band; otherwise a message for the rate form or certification finding. */
export function fxVolatilityOutOfBand(policy: FxCorridorPolicy, volatilityBp: number): string | null {
  return volatilityBp < policy.minVolatilityBp || volatilityBp > policy.maxVolatilityBp
    ? `Volatility margin ${volatilityBp} bp is outside the ${policy.corridor.toLowerCase()} corridor band ${policy.minVolatilityBp} to ${policy.maxVolatilityBp} bp`
    : null;
}
