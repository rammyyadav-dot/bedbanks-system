import { isLargePriceChange } from '../supply/price-guardrails'

/**
 * Rules a resolved feed rate and a feed batch must satisfy before anything may be promoted into a contracted plan (ADR 0082, owner decisions 1 and 2). Pure: no I/O, integer maths only.
 * Promotion itself is not built; these are the gates it must call, written and tested first so they cannot be softened by the writer.
 */
export type PromotionBlock = 'BASIS_NOT_NET' | 'TAX_NOT_STATED_INCLUSIVE' | 'PLAN_TAX_FLAG_NOT_SET' | 'CURRENCY_NOT_ENABLED' | 'CURRENCY_NOT_PLAN_CURRENCY' | 'NET_NOT_POSITIVE'

export interface PromotableRate {
  /** The ingest profile's declared basis. Anything but exactly 'NET' blocks: it is never defaulted and a feed never publishes an agent-facing SELL price. */
  profileBasis: string | null | undefined
  observation: { taxesIncluded: boolean | null; currency: string; netMinor: bigint | number }
  plan: { taxesIncluded: boolean; currency: string }
  /** The settlement currencies the platform enables (ADR 0029: AED at launch). */
  enabledCurrencies: readonly string[]
}

/** The first rule a rate breaks, or null. Nothing is converted, guessed or defaulted: an unstated tax basis is a block, and no tax line is ever created. */
export function checkRatePromotable(r: PromotableRate): PromotionBlock | null {
  if (r.profileBasis !== 'NET') return 'BASIS_NOT_NET'
  if (r.observation.taxesIncluded !== true) return 'TAX_NOT_STATED_INCLUSIVE'
  if (!r.plan.taxesIncluded) return 'PLAN_TAX_FLAG_NOT_SET'
  if (!r.enabledCurrencies.includes(r.observation.currency)) return 'CURRENCY_NOT_ENABLED'
  if (r.observation.currency !== r.plan.currency) return 'CURRENCY_NOT_PLAN_CURRENCY'
  if (BigInt(r.observation.netMinor) <= 0n) return 'NET_NOT_POSITIVE'
  return null
}

/**
 * A feed batch is held for a person when a night moves more than 30%, or more than 20% of previously promoted nights vanish from it (owner decision 1b). This is deliberately stricter than the
 * 50% confirmation guardrail for manual edits (ADR 0067 F-13): a person confirming a manual edit sees the numbers, while nobody watches a feed.
 */
export const FEED_BATCH_GUARD = Object.freeze({ maxMoveBp: 3_000, maxDroppedNightsBp: 2_000 })

export type BatchHoldReason = 'LARGE_PRICE_MOVE' | 'NIGHTS_DROPPED'
export interface BatchGuardResult { hold: boolean; reasons: BatchHoldReason[]; largeMoves: number; droppedNights: number; previousNights: number }

/**
 * `previous` and `incoming` map `<plan>|<night>` to the nightly net, for the same plans and the same future window. A night present before and absent now counts as dropped;
 * a first price is not a move. The batch is held as a whole: no night of a held batch is promoted.
 */
export function evaluateBatchGuard(previous: ReadonlyMap<string, bigint>, incoming: ReadonlyMap<string, bigint>, guard: { maxMoveBp: number; maxDroppedNightsBp: number } = FEED_BATCH_GUARD): BatchGuardResult {
  let largeMoves = 0
  let droppedNights = 0
  for (const [key, before] of previous) {
    const after = incoming.get(key)
    if (after === undefined) droppedNights++
    else if (isLargePriceChange(before, after, guard.maxMoveBp)) largeMoves++
  }
  const reasons: BatchHoldReason[] = []
  if (largeMoves > 0) reasons.push('LARGE_PRICE_MOVE')
  if (previous.size > 0 && droppedNights * 10_000 > previous.size * guard.maxDroppedNightsBp) reasons.push('NIGHTS_DROPPED')
  return { hold: reasons.length > 0, reasons, largeMoves, droppedNights, previousNights: previous.size }
}
