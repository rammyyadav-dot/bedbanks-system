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
