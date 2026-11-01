/**
 * Whether activating a rate plan needs a second person (ADR 0057, S5, decision D1).
 *
 * `RATE_PLAN_ACTIVATION_APPROVAL` is read at call time. Unset or empty means `required`. `off` is the only other accepted value and is an
 * explicit operator decision (for example a tenant with a single rate manager); it is recorded in the audit event of every direct activation.
 * Any other value is a misconfiguration and fails closed to `required`; it never weakens the control.
 */
export type ActivationApprovalMode = 'required' | 'off'

export function activationApprovalMode(env: Record<string, string | undefined> = process.env): ActivationApprovalMode {
  return env.RATE_PLAN_ACTIVATION_APPROVAL?.trim().toLowerCase() === 'off' ? 'off' : 'required'
}

/** True when the value is set to something that is neither empty, `required` nor `off`: reported at boot, still enforced as `required`. */
export function activationApprovalMisconfigured(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.RATE_PLAN_ACTIVATION_APPROVAL?.trim().toLowerCase()
  return raw !== undefined && raw !== '' && raw !== 'required' && raw !== 'off'
}
