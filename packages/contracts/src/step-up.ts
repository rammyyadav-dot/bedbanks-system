/**
 * Password step-up for maker-checker decisions (ADR 0095). The checker re-enters their password in this body field when they approve. The API
 * verifies it against the signed-in user, removes it from the request before any handler runs, and never stores or logs it.
 */
export const STEP_UP_FIELD = 'stepUpPassword' as const

export interface StepUpFields {
  stepUpPassword: string
}

/** Error codes the API returns when a maker-checker precondition is not met. */
export const STEP_UP_ERROR_CODES = ['STEP_UP_REQUIRED', 'STEP_UP_FAILED', 'STEP_UP_THROTTLED', 'APPROVAL_EXPIRED', 'DUAL_APPROVAL_REQUIRED'] as const
export type StepUpErrorCode = (typeof STEP_UP_ERROR_CODES)[number]
