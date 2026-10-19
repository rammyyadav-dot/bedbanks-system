export type RatePlanLifecycleStatus = 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'

export interface RatePlanReadinessCheck { code: string; label: string; ok: boolean; message: string }

/** GET /supply/rate-plans/:ratePlanId/readiness. `updatedAt` is the version that activate and suspend must echo as `expectedUpdatedAt`. */
export interface RatePlanReadiness {
  ratePlanId: string
  status: RatePlanLifecycleStatus
  updatedAt: string
  ready: boolean
  checks: RatePlanReadinessCheck[]
}

export interface RatePlanActivateRequest { expectedUpdatedAt: string; reason?: string }
export interface RatePlanSuspendRequest { expectedUpdatedAt: string; reason: string }
export interface RatePlanCloneRequest { code: string; roomTypeId?: string }

/** Conflict codes returned in the error body by the lifecycle routes. */
export type RatePlanLifecycleErrorCode = 'RATE_PLAN_CHANGED' | 'RATE_PLAN_NOT_READY' | 'RATE_PLAN_TRANSITION_NOT_ALLOWED' | 'RATE_PLAN_CODE_EXISTS'

/**
 * GET /supply/rate-plans/capabilities (`supply.rates.read`). What this environment's database identities can do for each lifecycle action, so
 * the Admin can hide or explain a control instead of showing it and failing (ADR 0041 Amendment 3). Derived on the server from the actual
 * database privileges and configuration; it never reports the credential, host or role names. The database remains the authority: a
 * `true` here does not bypass permission, readiness, versioning or audit.
 */
export type RatePlanCapabilityReason = 'LIFECYCLE_ROLE_NOT_PROVISIONED' | 'STRICT_ROLE_NO_WRITER'
export interface RatePlanActionCapability { available: boolean; reason: RatePlanCapabilityReason | null }
export interface RatePlanCapabilities {
  activate: RatePlanActionCapability; suspend: RatePlanActionCapability; clone: RatePlanActionCapability
  /** `required`: activation goes through a second person (ADR 0057, S5) and `POST .../activate` is refused. `off` is an explicit operator decision recorded in the audit event. */
  activationApproval: 'required' | 'off'
}

/**
 * Four-eye activation (ADR 0057, S5). A requester files a request bound to the exact plan content they reviewed; a different user with
 * `supply.rates.manage` approves or rejects it; the approved request is applied once, after readiness is re-run and the content is re-checked.
 */
export type RatePlanApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXECUTED'
export interface RatePlanActivationRequestInput { requestId: string; reason: string; expectedUpdatedAt: string }
export interface RatePlanApprovalDecisionInput { reason: string }
export interface RatePlanActivationApproval {
  id: string; ratePlanId: string; status: RatePlanApprovalStatus
  requestedById: string; reason: string
  decidedById: string | null; decisionReason: string | null; decidedAt: string | null
  executedAt: string | null; createdAt: string
  /** The plan version the request was bound to. */
  boundUpdatedAt: string | null
  /** Computed for the calling user. The server still enforces each rule. */
  isRequester: boolean; canDecide: boolean; canCancel: boolean; canExecute: boolean
}
export interface RatePlanApprovalExecuteResult { approval: RatePlanActivationApproval; ratePlanId: string; status: 'ACTIVE' }

/**
 * Child and extra-adult price lines of a rate plan (ADR 0057, S6). Per night, per guest, on top of the plan's base nightly rate (which is for
 * `occupancy` adults). A plan with no lines keeps the flat rule. `GET` returns the lines and the plan version; `PUT` replaces them all atomically.
 */
export type GuestPriceKind = 'CHILD' | 'EXTRA_ADULT'
export interface RatePlanGuestPriceLine {
  kind: GuestPriceKind
  /** Child band, inclusive, 0 to 17. For EXTRA_ADULT the server stores and returns the sentinel band 18 to 99. */
  minAge: number; maxAge: number
  /** Integer minor units per night per guest, as a decimal string. Zero is an explicit free guest. */
  amountMinor: string
  amountBasis: 'NET' | 'SELL'
  currency: string
}
export interface RatePlanGuestPrices { ratePlanId: string; updatedAt: string; currency: string; occupancy: number; lines: RatePlanGuestPriceLine[] }
/**
 * Promotions on a rate plan (ADR 0058, S10a). At most one applies to a stay (the largest saving; they never stack) and it is taken off the nightly net
 * before the markup. `GET` returns the promotions and the plan version; `PUT` replaces them all atomically.
 */
export type PromotionKind = 'EARLY_BIRD' | 'LAST_MINUTE' | 'LONG_STAY' | 'FREE_NIGHTS'
export interface RatePlanPromotion {
  id?: string
  kind: PromotionKind
  /** 1 to 80 characters; agents see it. Unique per plan ignoring case. */
  name: string
  /** Basis points off every night, 1 to 9000. Percent kinds only. */
  percentBp: number | null
  /** EARLY_BIRD: whole days of notice required. LAST_MINUTE: whole days of notice allowed at most. Hotel-local calendar. */
  minLeadDays: number | null
  maxLeadDays: number | null
  /** LONG_STAY and FREE_NIGHTS: the stay must have at least this many nights. */
  minNights: number | null
  /** FREE_NIGHTS: how many of the cheapest nights are free; below minNights. */
  freeNights: number | null
  /** Optional windows, YYYY-MM-DD inclusive: when the booking is made (hotel-local today) and the nights that must all fall inside. */
  bookFrom: string | null; bookTo: string | null; stayFrom: string | null; stayTo: string | null
  /** ADR 0067 F-09. combinable: may stack with the plan's other combinable promotions. stayWindowMode NIGHTS_IN_WINDOW: only nights inside the stay window are discounted. discountBase ROOM_ONLY: extra-guest lines are not discounted. Omitted on write: false, WHOLE_STAY, ROOM_AND_GUESTS. */
  combinable?: boolean; stayWindowMode?: 'WHOLE_STAY' | 'NIGHTS_IN_WINDOW'; discountBase?: 'ROOM_AND_GUESTS' | 'ROOM_ONLY'
}
/** ADR 0067 F-09: one promotion added to many plans of a hotel, all or nothing. */
export interface HotelPromotionBulkApplyInput { idempotencyKey: string; ratePlanIds: string[]; promotion: RatePlanPromotion }
export interface HotelPromotionBulkApplyResult { hotelId: string; promotion: string; ratePlanIds: string[]; applied: number; idempotencyKey: string; replayed: boolean }
export interface RatePlanPromotions { ratePlanId: string; updatedAt: string; promotions: RatePlanPromotion[] }
export interface RatePlanPromotionsInput { expectedUpdatedAt: string; promotions: RatePlanPromotion[]; reason?: string }
/**
 * Derived rates (ADR 0058, S10b). A derived plan sells at its parent's nightly rate for the same date, adjusted, and owns no rates. The parent must be a plan
 * of the same contract, hotel, currency and occupancy that is not itself derived. `PERCENT_BP` adjustment is signed basis points (-9000 to 100000);
 * `FIXED_MINOR` is signed minor units (at most 2,000,000,000). Both are whole numbers.
 */
export type DerivedRateMode = 'PERCENT_BP' | 'FIXED_MINOR'
export interface RatePlanDerivation {
  ratePlanId: string
  updatedAt: string
  status: string
  currency: string
  derived: { parentId: string; parentCode: string; mode: DerivedRateMode; adjustment: number } | null
  /** Plans this one could be derived from: same contract, hotel, currency and occupancy, not themselves derived. */
  candidates: Array<{ id: string; code: string; roomName: string }>
  /** True when the plan holds its own rate rows (it must be emptied before it can be derived). */
  hasOwnRates: boolean
  /** True when other plans derive from this one (it cannot itself be derived). */
  hasDerivedPlans: boolean
}
export interface RatePlanDerivationInput {
  expectedUpdatedAt: string
  /** The parent plan, or null to remove the derivation. */
  parentId: string | null
  mode?: DerivedRateMode
  adjustment?: number
  reason?: string
}
export interface RatePlanGuestPricesInput {
  expectedUpdatedAt: string
  /** Each line: `minAge`/`maxAge` are required for CHILD and ignored for EXTRA_ADULT. */
  lines: Array<{ kind: GuestPriceKind; minAge?: number; maxAge?: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string }>
  reason?: string
}

