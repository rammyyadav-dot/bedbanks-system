/**
 * Derived rate plans (ADR 0058, S10b). Pure: no I/O, no clock.
 *
 * A derived plan sells at its PARENT's nightly rate for the same date plus or minus a signed adjustment, in the parent's basis (NET or SELL) and currency.
 * It owns no rate rows. This module turns the parent's rows into the derived plan's rows, so every consumer of `dailyRates` (Agent search, recheck, hold,
 * simulator, readiness, the Admin views) prices a derived plan through the one evaluator without a second code path. Anything that does not hold fails
 * closed with a typed reason and no rates: a derived plan is never priced from a guess.
 *
 * PERCENT_BP: the magnitude `(parent * |bp| + 5000) / 10000` is rounded half up on integers, then added or subtracted. FIXED_MINOR: the adjustment is added.
 * A night whose result is below 1 minor unit gets amount 0, which the evaluator and the audit already treat as an invalid rate: that night, and so the stay,
 * is not sold.
 */
export type DerivedRateMode = 'PERCENT_BP' | 'FIXED_MINOR'
export const DERIVED_PERCENT_MIN_BP = -9000
export const DERIVED_PERCENT_MAX_BP = 100_000
export const DERIVED_FIXED_LIMIT = 2_000_000_000

export type DerivedProblem = 'DERIVED_TERMS_INVALID' | 'DERIVED_PARENT_MISSING' | 'DERIVED_PARENT_IS_DERIVED' | 'DERIVED_PARENT_MISMATCH' | 'DERIVED_PARENT_INACTIVE'

export interface RateRowLike { stayDate: Date; amountMinor: bigint; currency: string; amountBasis: string | null; occupancy?: number }
export interface DerivedParent {
  id: string; code?: string; status: string; occupancy: number; currency: string; contractId: string; derivedFromId: string | null
  roomType: { hotelId: string }
  dailyRates: RateRowLike[]
}
export interface DerivablePlan {
  id: string; occupancy: number; currency: string; contractId: string
  roomType: { hotelId: string }
  derivedFromId: string | null; derivedMode: string | null; derivedAdjustment: number | null
  derivedFrom: DerivedParent | null
  dailyRates: RateRowLike[]
}

/** The derived nightly rate for one parent night. May be below 1: the caller marks that night invalid. */
export function deriveNightly(parentMinor: bigint, mode: DerivedRateMode, adjustment: number): bigint {
  const adjust = BigInt(adjustment)
  if (mode === 'FIXED_MINOR') return parentMinor + adjust
  const magnitude = (parentMinor * (adjust < 0n ? -adjust : adjust) + 5000n) / 10000n
  return adjust < 0n ? parentMinor - magnitude : parentMinor + magnitude
}

export function validDerivedTerms(mode: unknown, adjustment: unknown): boolean {
  if (typeof adjustment !== 'number' || !Number.isInteger(adjustment)) return false
  if (mode === 'PERCENT_BP') return adjustment >= DERIVED_PERCENT_MIN_BP && adjustment <= DERIVED_PERCENT_MAX_BP
  if (mode === 'FIXED_MINOR') return adjustment >= -DERIVED_FIXED_LIMIT && adjustment <= DERIVED_FIXED_LIMIT
  return false
}

/** Why a derived plan cannot be priced, or null when its parent and terms are sound. Null for a plan that is not derived. */
export function derivedProblem(plan: DerivablePlan): DerivedProblem | null {
  if (plan.derivedFromId === null) return null
  if (!validDerivedTerms(plan.derivedMode, plan.derivedAdjustment)) return 'DERIVED_TERMS_INVALID'
  const parent = plan.derivedFrom
  if (!parent || parent.id !== plan.derivedFromId || parent.id === plan.id) return 'DERIVED_PARENT_MISSING'
  if (parent.derivedFromId !== null) return 'DERIVED_PARENT_IS_DERIVED'
  if (parent.contractId !== plan.contractId || parent.roomType.hotelId !== plan.roomType.hotelId || parent.currency !== plan.currency || parent.occupancy !== plan.occupancy) return 'DERIVED_PARENT_MISMATCH'
  if (parent.status !== 'ACTIVE') return 'DERIVED_PARENT_INACTIVE'
  return null
}

/**
 * The plan as the evaluator and the views must see it: a derived plan's `dailyRates` become its parent's rows (own occupancy) adjusted, and `derivedProblem`
 * says why there are none when the parent or terms do not hold. A plan that is not derived is returned with `derivedProblem: null` and its rates untouched.
 */
export function withDerivedRates<T extends DerivablePlan>(plan: T): T & { derivedProblem: DerivedProblem | null } {
  const problem = derivedProblem(plan)
  if (plan.derivedFromId === null) return { ...plan, derivedProblem: null }
  if (problem !== null) return { ...plan, dailyRates: [], derivedProblem: problem }
  const mode = plan.derivedMode as DerivedRateMode
  const adjustment = plan.derivedAdjustment as number
  const rows = plan.derivedFrom!.dailyRates.filter((row) => row.occupancy === undefined || row.occupancy === plan.occupancy).map((row): RateRowLike => {
    const amount = deriveNightly(row.amountMinor, mode, adjustment)
    return { ...row, amountMinor: amount < 1n ? 0n : amount }
  })
  return { ...plan, dailyRates: rows, derivedProblem: null }
}

/** The select that loads a derived plan's parent with the parent's rates in the same window. Spread into a Prisma `select` or `include`. */
export const derivedParentSelect = (ratesWhere: object) => ({
  id: true, code: true, status: true, occupancy: true, currency: true, contractId: true, derivedFromId: true,
  roomType: { select: { hotelId: true } },
  dailyRates: { where: ratesWhere, select: { stayDate: true, amountMinor: true, currency: true, amountBasis: true, occupancy: true } },
}) as const
