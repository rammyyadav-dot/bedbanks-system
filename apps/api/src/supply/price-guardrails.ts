import { PRICE_GUARDRAIL } from '@bedbanks/contracts'

/**
 * Price-change guardrail (ADR 0067, F-13). Pure, integer arithmetic only. A change that moves a stored rate by more than
 * `PRICE_GUARDRAIL.maxChangeBp` of its current value is a large change: preview flags it and apply needs an explicit confirmation, so a typo such
 * as 45 for 450 or 4500 for 450 is never written silently. A first price (no stored rate) is not a change and is not flagged.
 */
export function isLargePriceChange(fromMinor: bigint | null, toMinor: bigint, maxChangeBp: number = PRICE_GUARDRAIL.maxChangeBp): boolean {
  if (fromMinor === null || fromMinor <= 0n) return false
  const delta = toMinor > fromMinor ? toMinor - fromMinor : fromMinor - toMinor
  return delta * 10_000n > fromMinor * BigInt(maxChangeBp)
}

/** The change in signed basis points of the old value, rounded toward zero, for messages. */
export const changeBp = (fromMinor: bigint, toMinor: bigint): number => Number(((toMinor - fromMinor) * 10_000n) / fromMinor)

export const largeChangeWarning = (fromMinor: bigint, toMinor: bigint): string => {
  const bp = changeBp(fromMinor, toMinor)
  return `the price moves ${bp > 0 ? '+' : ''}${Math.trunc(bp / 100)}% (more than ${PRICE_GUARDRAIL.maxChangeBp / 100}%): confirm large changes to apply` // no-float-check: display-only
}
