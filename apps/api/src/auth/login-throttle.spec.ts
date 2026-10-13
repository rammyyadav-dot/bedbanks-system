import { LOGIN_THROTTLE_LIMITS, LoginThrottle } from './login-throttle'

describe('LoginThrottle (CTO audit F08)', () => {
  let clock = 1_000_000
  const throttle = () => new LoginThrottle(() => clock)
  beforeEach(() => { clock = 1_000_000 })

  it('blocks an account from one address after the account limit, with a retry time', () => {
    const t = throttle()
    for (let i = 0; i < LOGIN_THROTTLE_LIMITS.perAccount; i++) { expect(t.check('A@x.test', '1.1.1.1').allowed).toBe(true); t.recordFailure('A@x.test', '1.1.1.1'); clock += 1000 }
    const blocked = t.check('a@x.test', '1.1.1.1') // email case does not matter
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(LOGIN_THROTTLE_LIMITS.windowMs / 1000)
  })

  it('does not let one address lock the same account out for everyone else', () => {
    const t = throttle()
    for (let i = 0; i < 10; i++) t.recordFailure('a@x.test', '1.1.1.1')
    expect(t.check('a@x.test', '2.2.2.2').allowed).toBe(true)
  })

  it('blocks one address that sprays many accounts', () => {
    const t = throttle()
    for (let i = 0; i < LOGIN_THROTTLE_LIMITS.perAddress; i++) t.recordFailure(`u${i}@x.test`, '3.3.3.3')
    expect(t.check('brand-new@x.test', '3.3.3.3').allowed).toBe(false)
    expect(t.check('brand-new@x.test', '4.4.4.4').allowed).toBe(true)
  })

  it('allows attempts again once the window has passed', () => {
    const t = throttle()
    for (let i = 0; i < LOGIN_THROTTLE_LIMITS.perAccount; i++) t.recordFailure('a@x.test', '1.1.1.1')
    expect(t.check('a@x.test', '1.1.1.1').allowed).toBe(false)
    clock += LOGIN_THROTTLE_LIMITS.windowMs + 1
    expect(t.check('a@x.test', '1.1.1.1').allowed).toBe(true)
  })

  it('clears the account counter on success', () => {
    const t = throttle()
    for (let i = 0; i < LOGIN_THROTTLE_LIMITS.perAccount - 1; i++) t.recordFailure('a@x.test', '1.1.1.1')
    t.recordSuccess('a@x.test', '1.1.1.1')
    t.recordFailure('a@x.test', '1.1.1.1')
    expect(t.check('a@x.test', '1.1.1.1').allowed).toBe(true)
  })

  it('stays bounded under a flood of distinct keys', () => {
    const t = throttle()
    for (let i = 0; i < LOGIN_THROTTLE_LIMITS.maxKeys + 500; i++) t.recordFailure(`u${i}@x.test`, `10.0.${i % 250}.${i % 7}`)
    expect((t as unknown as { failures: Map<string, unknown> }).failures.size).toBeLessThanOrEqual(LOGIN_THROTTLE_LIMITS.maxKeys + 2)
  })
})
