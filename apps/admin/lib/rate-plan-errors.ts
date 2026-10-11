import { RUNTIME_ROLE_OPERATION_PROHIBITED } from '@bedbanks/contracts'
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
  if (error.code === 'RATE_PLAN_NOT_READY') return `Activation checks failed. The checklist above shows what to fix.${ref}`
  return `${describeApiError(error, ACTION_LABEL[action])}${ref}`
}
