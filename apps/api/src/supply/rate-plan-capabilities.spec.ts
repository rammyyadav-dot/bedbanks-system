import { deriveRatePlanCapabilities } from './rate-plan-capabilities'

describe('deriveRatePlanCapabilities (ADR 0041 Amendment 3)', () => {
  it('strict runtime login without the lifecycle role: nothing is available', () => {
    const c = deriveRatePlanCapabilities({ opsRoleConfigured: false, runtimeCanUpdateStatus: false, runtimeCanInsert: false, cloneRoleConfigured: false, activationApproval: 'required' })
    expect(c.activate).toEqual({ available: false, reason: 'LIFECYCLE_ROLE_NOT_PROVISIONED' })
    expect(c.suspend).toEqual({ available: false, reason: 'LIFECYCLE_ROLE_NOT_PROVISIONED' })
    expect(c.clone).toEqual({ available: false, reason: 'STRICT_ROLE_NO_WRITER' })
  })

  it('strict runtime login with the lifecycle role: activate and suspend work, clone stays unavailable', () => {
    const c = deriveRatePlanCapabilities({ opsRoleConfigured: true, runtimeCanUpdateStatus: false, runtimeCanInsert: false, cloneRoleConfigured: false, activationApproval: 'required' })
    expect(c.activate.available).toBe(true)
    expect(c.suspend.available).toBe(true)
    expect(c.clone).toEqual({ available: false, reason: 'STRICT_ROLE_NO_WRITER' })
  })

  it('the lifecycle role never makes clone available', () => {
    expect(deriveRatePlanCapabilities({ opsRoleConfigured: true, runtimeCanUpdateStatus: false, runtimeCanInsert: false, cloneRoleConfigured: false, activationApproval: 'required' }).clone.available).toBe(false)
  })

  it('a disposable owner connection can do everything without the lifecycle role', () => {
    const c = deriveRatePlanCapabilities({ opsRoleConfigured: false, runtimeCanUpdateStatus: true, runtimeCanInsert: true, cloneRoleConfigured: false, activationApproval: 'off' })
    expect([c.activate.available, c.suspend.available, c.clone.available]).toEqual([true, true, true])
  })
  it('reports the activation approval mode as given, never inferring it from the database', () => {
    expect(deriveRatePlanCapabilities({ opsRoleConfigured: true, runtimeCanUpdateStatus: false, runtimeCanInsert: false, cloneRoleConfigured: false, activationApproval: 'required' }).activationApproval).toBe('required')
    expect(deriveRatePlanCapabilities({ opsRoleConfigured: true, runtimeCanUpdateStatus: false, runtimeCanInsert: false, cloneRoleConfigured: false, activationApproval: 'off' }).activationApproval).toBe('off')
  })
  it('clone is available when the clone role is configured, even though the runtime login cannot insert', () => {
    const c = deriveRatePlanCapabilities({ opsRoleConfigured: true, runtimeCanUpdateStatus: false, runtimeCanInsert: false, cloneRoleConfigured: true, activationApproval: 'required' })
    expect(c.clone).toEqual({ available: true, reason: null })
    expect(deriveRatePlanCapabilities({ opsRoleConfigured: true, runtimeCanUpdateStatus: false, runtimeCanInsert: false, cloneRoleConfigured: false, activationApproval: 'required' }).clone.available).toBe(false)
  })
})
