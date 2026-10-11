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
export interface RatePlanCapabilities { activate: RatePlanActionCapability; suspend: RatePlanActionCapability; clone: RatePlanActionCapability }
