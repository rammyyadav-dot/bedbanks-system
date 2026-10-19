import { minorUnitExponent } from '@bedbanks/money'

/**
 * Controlled FX (ADR 0067, F-12). Pure, BigInt only: no float touches money.
 *
 * `rateScaled` is quote major units per one base major unit, times 10^8. `bufferBp` is added on top to cover movement until settlement, so the
 * buyer pays slightly more than the mid rate and the DMC is not short when it pays the hotel in the base currency. Conversion rounds half up,
 * once, on the amount converted; each currency's own number of minor digits (AED 2, KWD 3, JPY 0) is respected.
 */
export const RATE_SCALE = 100_000_000n
export const MAX_FX_BUFFER_BP = 2000

export interface FxQuote { from: string; to: string; rateScaled: bigint; bufferBp: number }

export function convertMinor(amountMinor: bigint, fx: FxQuote): bigint {
  const fromScale = 10n ** BigInt(minorUnitExponent(fx.from))
  const toScale = 10n ** BigInt(minorUnitExponent(fx.to))
  const numerator = amountMinor * fx.rateScaled * BigInt(10_000 + fx.bufferBp) * toScale
  const denominator = RATE_SCALE * 10_000n * fromScale
  const sign = numerator < 0n ? -1n : 1n
  const abs = numerator < 0n ? -numerator : numerator
  return sign * ((abs + denominator / 2n) / denominator)
}

/** The effective rate a booking freezes (rate with buffer), as a decimal string with eight places, for `Booking.fxRate`. */
export function effectiveRateDecimal(fx: Pick<FxQuote, 'rateScaled' | 'bufferBp'>): string {
  const scaled = (fx.rateScaled * BigInt(10_000 + fx.bufferBp) + 5_000n) / 10_000n
  const whole = scaled / RATE_SCALE
  const fraction = (scaled % RATE_SCALE).toString().padStart(8, '0')
  return `${whole}.${fraction}`
}

/** A rate as staff type it (quote per base, up to eight decimal places) to the scaled integer; null when not a positive decimal with at most 8 places. */
export function parseRate(text: unknown): bigint | null {
  if (typeof text !== 'string') return null
  const m = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(text.trim())
  if (!m) return null
  const value = BigInt(m[1]!) * RATE_SCALE + BigInt((m[2] ?? '').padEnd(8, '0'))
  return value > 0n ? value : null
}
