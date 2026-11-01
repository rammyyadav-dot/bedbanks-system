/**
 * Pure tier resolution and commission arithmetic for agency commission payouts (ADR 0098). No database, no floating point: every
 * threshold and rate is a whole number (minor units or basis points), and the amount is computed with bigint floor division, so
 * the same input always produces the same output and the service layer can unit-test it without a transaction.
 */
export type AgencyCommissionTierName = 'BRONZE' | 'SILVER' | 'GOLD' | 'ENTERPRISE'

export interface CommissionTierRule {
  tier: AgencyCommissionTierName
  /** Gross booked volume in minor units, inclusive, that this tier starts at. */
  minGrossBookedMinor: bigint
  commissionBp: number
}

/**
 * Default tier table (operator policy, not a supplier price): thresholds are in USD-equivalent minor units for the period.
 * Ordered ascending by threshold; the resolver picks the highest tier the volume clears. Override with `rules` for a
 * deployment that prices tiers differently; the shape stays the same so the resolver logic never changes.
 */
export const DEFAULT_COMMISSION_TIERS: readonly CommissionTierRule[] = [
  { tier: 'BRONZE', minGrossBookedMinor: 0n, commissionBp: 200 },
  { tier: 'SILVER', minGrossBookedMinor: 5_000_000n, commissionBp: 300 },
  { tier: 'GOLD', minGrossBookedMinor: 25_000_000n, commissionBp: 400 },
  { tier: 'ENTERPRISE', minGrossBookedMinor: 100_000_000n, commissionBp: 500 },
]

export interface ResolvedCommissionTier { tier: AgencyCommissionTierName; commissionBp: number }

/** Resolves the tier a given gross booked volume clears. `rules` must be sorted ascending by threshold and start at 0; throws otherwise so a misconfigured table is never silent. */
export function resolveCommissionTier(grossBookedMinor: bigint, rules: readonly CommissionTierRule[] = DEFAULT_COMMISSION_TIERS): ResolvedCommissionTier {
  if (grossBookedMinor < 0n) throw new Error('grossBookedMinor must not be negative')
  if (rules.length === 0 || rules[0].minGrossBookedMinor !== 0n) throw new Error('Commission tier rules must start at a zero threshold')
  for (let i = 1; i < rules.length; i++) {
    if (rules[i].minGrossBookedMinor <= rules[i - 1].minGrossBookedMinor) throw new Error('Commission tier rules must be strictly ascending by threshold')
  }
  let resolved = rules[0]
  for (const rule of rules) if (grossBookedMinor >= rule.minGrossBookedMinor) resolved = rule
  return { tier: resolved.tier, commissionBp: resolved.commissionBp }
}

/** floor(grossBookedMinor * commissionBp / 10000), the same rounding direction the platform uses for any proportional charge. */
export function commissionAmountMinor(grossBookedMinor: bigint, commissionBp: number): bigint {
  if (grossBookedMinor < 0n) throw new Error('grossBookedMinor must not be negative')
  if (!Number.isInteger(commissionBp) || commissionBp < 0 || commissionBp > 10_000) throw new Error('commissionBp must be a whole number of basis points from 0 to 10000')
  return (grossBookedMinor * BigInt(commissionBp)) / 10_000n
}

export interface CalculatedCommission { tier: AgencyCommissionTierName; commissionBp: number; amountMinor: bigint }

/** Resolves the tier and the payable amount for one agency's gross booked volume in a closed period. */
export function calculateCommission(grossBookedMinor: bigint, rules: readonly CommissionTierRule[] = DEFAULT_COMMISSION_TIERS): CalculatedCommission {
  const { tier, commissionBp } = resolveCommissionTier(grossBookedMinor, rules)
  return { tier, commissionBp, amountMinor: commissionAmountMinor(grossBookedMinor, commissionBp) }
}
