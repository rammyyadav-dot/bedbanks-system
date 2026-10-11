import type { RatePlanCapabilities } from '@bedbanks/contracts'

export interface RatePlanCapabilityFacts {
  /** `RATE_PLAN_OPS_DATABASE_URL` is set and differs from `DATABASE_URL` (ADR 0041 Amendment 2). Configured is not proof it is reachable. */
  opsRoleConfigured: boolean
  /** The runtime identity may UPDATE `RatePlan.status` (an owner connection in a disposable environment; never the strict login). */
  runtimeCanUpdateStatus: boolean
  /** The runtime identity may INSERT into `RatePlan` (clone is the only lifecycle action that inserts). */
  runtimeCanInsert: boolean
}

/**
 * Pure decision of which lifecycle actions can work in this environment (ADR 0041 Amendment 3). Activate and suspend are available through
 * the narrow role when it is configured, otherwise only if the runtime identity itself may write the status. Clone never uses the narrow
 * role (it must not insert a row), so under a strict login it stays unavailable until a separately approved writer exists.
 */
export function deriveRatePlanCapabilities(facts: RatePlanCapabilityFacts): RatePlanCapabilities {
  const transition = facts.opsRoleConfigured || facts.runtimeCanUpdateStatus
    ? { available: true, reason: null }
    : { available: false, reason: 'LIFECYCLE_ROLE_NOT_PROVISIONED' as const }
  return {
    activate: transition,
    suspend: transition,
    clone: facts.runtimeCanInsert ? { available: true, reason: null } : { available: false, reason: 'STRICT_ROLE_NO_WRITER' },
  }
}
