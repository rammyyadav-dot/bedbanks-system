/**
 * Hotel onboarding funnel (`GET /admin/operations/onboarding-funnel`).
 *
 * A read-only, tenant-wide count of how far each hotel has progressed through the catalogue set-up stages. Stages are
 * cumulative and ordered: a hotel is counted at a stage only when it also passed every earlier stage, and its `blocker` is
 * the first stage it fails. Each stage is a structural fact read from the masters (a published hotel, an approved mapping,
 * an ACTIVE contract, future rates, future stock). It is NOT the sellability evaluator's verdict: a hotel that reaches
 * `INVENTORY_LOADED` may still fail a stay-specific rule. Use the hotel readiness assessment for that.
 *
 * `null` counts mean the caller lacks the read permission for the evidence behind that stage, or for an earlier stage the
 * count depends on; they are never zero. Hotels that pass every readable stage are neither blocked nor counted complete.
 */
export const ONBOARDING_STAGE_IDS = [
  'CREATED', 'PUBLISHED', 'ROOMS_DEFINED', 'HOTEL_MAPPED', 'ROOMS_MAPPED', 'CONTRACT_ACTIVE', 'RATE_PLAN_ACTIVE', 'RATES_LOADED', 'INVENTORY_LOADED',
] as const
export type OnboardingStageId = (typeof ONBOARDING_STAGE_IDS)[number]

export interface OnboardingStageCount {
  stage: OnboardingStageId
  label: string
  /** Permission needed to read the evidence for this stage, or null when the hotel read permission is enough. */
  permission: string | null
  /** Hotels that passed this stage and every earlier one. Null when the caller cannot read the evidence (UNKNOWN). */
  reached: number | null
}

export interface OnboardingBlockedHotel {
  hotelId: string
  hotelName: string
  city: string
  /** Highest stage passed in order. */
  lastStageReached: OnboardingStageId
  /** First failing stage. */
  blocker: OnboardingStageId
}

export interface OnboardingFunnelReport {
  evaluatedAt: string
  /** Business date (UTC, `YYYY-MM-DD`) that "future" rates, stock and contract validity are measured from. */
  asOfDate: string
  totalHotels: number
  /** Hotels past every stage. A structural candidate, not certified sellable. Null when any stage is unreadable. */
  completeHotels: number | null
  stages: OnboardingStageCount[]
  /** Hotels per first-blocking stage, for hotels that are not complete. */
  blockers: Array<{ stage: OnboardingStageId; hotels: number | null }>
  /** First blocked hotels (name order), capped at `blockedHotelsLimit`. */
  blockedHotels: OnboardingBlockedHotel[]
  blockedHotelsLimit: number
  blockedHotelsTruncated: boolean
  scope: string
  limitations: string[]
}
