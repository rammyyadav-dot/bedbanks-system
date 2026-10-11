import { RUNTIME_ROLE_OPERATION_PROHIBITED } from '@bedbanks/contracts'
import type { RatePlanCapabilities, RatePlanCapabilityReason, RatePlanReadinessCheck } from '@bedbanks/contracts'
import { ApiResponseError } from './api/errors'
import { describeApiError } from './api/describe-error'

export type RatePlanAction = 'activate' | 'suspend' | 'clone'

const ACTION_LABEL: Record<RatePlanAction, string> = { activate: 'activate this rate plan', suspend: 'suspend this rate plan', clone: 'clone this rate plan' }

/**
 * Operator-facing text for a failed rate plan lifecycle action (ADR 0041). The generic 403 text says "you do not have permission", which is
 * wrong for a database-role refusal: that is the environment, not the person. The request id is appended so the failure can be traced in the audit log.
 */
export function describeRatePlanActionError(error: unknown, action: RatePlanAction): string {
  if (!(error instanceof ApiResponseError)) return describeApiError(error, ACTION_LABEL[action])
  const ref = error.requestId ? ` (request ${error.requestId})` : ''
  if (error.code === RUNTIME_ROLE_OPERATION_PROHIBITED) {
    return (action === 'clone'
      ? 'Cloning is not available in this environment: it needs a database writer that the strict runtime role does not have. Create the plan with "Create Rate Plan" instead. Nothing was changed.'
      : 'Status changes are not enabled in this environment: the rate plan lifecycle database role has not been provisioned. Ask an operator to set it up (ADR 0041). Nothing was changed.') + ref
  }
  if (error.code === 'RATE_PLAN_OPS_UNAVAILABLE') return `The rate plan lifecycle database role is configured but unavailable right now. Nothing was changed. Try again, or ask an operator to check it.${ref}`
  if (error.code === 'RATE_PLAN_CHANGED') return `This rate plan changed since you opened it. Close this panel and reopen it to review its current state.${ref}`
  if (error.code === 'RATE_PLAN_NOT_READY') return `Activation checks failed. The failed checks are listed below; fix them and retry.${ref}`
  return `${describeApiError(error, ACTION_LABEL[action])}${ref}`
}

/**
 * The failed readiness checks carried by a 409 RATE_PLAN_NOT_READY, read straight from the structured `error.details` so the dialog can show
 * them without a second request. Anything that is not a well-formed failed check is ignored; the readiness endpoint remains the source of truth.
 */
export function readinessFailuresFromError(error: unknown): RatePlanReadinessCheck[] {
  if (!(error instanceof ApiResponseError) || error.code !== 'RATE_PLAN_NOT_READY') return []
  return error.structuredDetails.flatMap((item) => {
    const c = item as Partial<RatePlanReadinessCheck> | null
    return c && typeof c.code === 'string' && typeof c.label === 'string' && typeof c.message === 'string' && c.ok === false ? [{ code: c.code, label: c.label, ok: false, message: c.message }] : []
  })
}

const CAPABILITY_REASON: Record<RatePlanCapabilityReason, Record<RatePlanAction, string>> = {
  LIFECYCLE_ROLE_NOT_PROVISIONED: {
    activate: 'Not available in this environment: the rate plan lifecycle database role is not provisioned. Ask an operator (ADR 0041).',
    suspend: 'Not available in this environment: the rate plan lifecycle database role is not provisioned. Ask an operator (ADR 0041).',
    clone: 'Not available in this environment.',
  },
  STRICT_ROLE_NO_WRITER: {
    activate: 'Not available in this environment.',
    suspend: 'Not available in this environment.',
    clone: 'Clone is not available in this environment: it needs a database writer the strict runtime role does not have. Use "Create Rate Plan" instead.',
  },
}

/** Why a lifecycle control is disabled, or null when it is usable. `undefined` capabilities (not loaded, or the request failed) fail closed. */
export function capabilityBlockedReason(capabilities: RatePlanCapabilities | undefined, action: RatePlanAction): string | null {
  if (!capabilities) return 'Availability could not be confirmed for this environment, so the control is disabled. Reload to retry.'
  const entry = capabilities[action]
  if (entry.available) return null
  return entry.reason ? CAPABILITY_REASON[entry.reason][action] : 'Not available in this environment.'
}
