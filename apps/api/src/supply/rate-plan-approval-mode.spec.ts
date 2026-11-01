import { activationApprovalMisconfigured, activationApprovalMode } from './rate-plan-approval-mode'

describe('rate plan activation approval mode (ADR 0057, S5)', () => {
  it('is required when unset or empty: the secure default', () => {
    expect(activationApprovalMode({})).toBe('required')
    expect(activationApprovalMode({ RATE_PLAN_ACTIVATION_APPROVAL: '' })).toBe('required')
    expect(activationApprovalMode({ RATE_PLAN_ACTIVATION_APPROVAL: '  ' })).toBe('required')
  })
  it('is off only for an explicit off, in any case', () => {
    expect(activationApprovalMode({ RATE_PLAN_ACTIVATION_APPROVAL: 'off' })).toBe('off')
    expect(activationApprovalMode({ RATE_PLAN_ACTIVATION_APPROVAL: ' OFF ' })).toBe('off')
  })
  it('fails closed on anything else: a typo never weakens the control', () => {
    for (const bad of ['false', '0', 'disabled', 'no', 'of', 'required-ish']) {
      expect(activationApprovalMode({ RATE_PLAN_ACTIVATION_APPROVAL: bad })).toBe('required')
      expect(activationApprovalMisconfigured({ RATE_PLAN_ACTIVATION_APPROVAL: bad })).toBe(true)
    }
    expect(activationApprovalMisconfigured({ RATE_PLAN_ACTIVATION_APPROVAL: 'off' })).toBe(false)
    expect(activationApprovalMisconfigured({})).toBe(false)
  })
})
