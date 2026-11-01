import { planNights, validateNightRequest } from './pool-night-authoring'

const ok = { tenantId: 'tenant_12345', poolId: 'pool_12345', from: '2030-06-01', to: '2030-06-05', capacity: 5, reason: 'Hotel confirmed stock', actor: 'ops person' }

describe('pool night authoring (pure)', () => {
  it('accepts a valid request and names every problem in an invalid one', () => {
    expect(validateNightRequest(ok)).toEqual([])
    const bad = validateNightRequest({ ...ok, tenantId: '', poolId: 'x', from: '2030-13-01', to: '2030-05-01', capacity: -1, reason: 'a', actor: '' })
    expect(bad.length).toBeGreaterThanOrEqual(6)
    expect(validateNightRequest({ ...ok, capacity: 2.5 })[0]).toMatch(/whole number/)
    expect(validateNightRequest({ ...ok, capacity: 10_000 })[0]).toMatch(/0 to 9999/)
    expect(validateNightRequest({ ...ok, from: '2030-01-01', to: '2031-06-01' })[0]).toMatch(/366/)
  })
  it('creates only missing future nights; existing and past nights are never written', () => {
    const dates = ['2030-05-30', '2030-06-01', '2030-06-02', '2030-06-03']
    const p = planNights(dates, new Set(['2030-06-02']), '2030-06-01', 'pool_1', 5)
    expect(p).toMatchObject({ create: ['2030-06-01', '2030-06-03'], existing: ['2030-06-02'], past: ['2030-05-30'] })
  })
  it('the fingerprint depends on the pool, the capacity and the nights to create', () => {
    const a = planNights(['2030-06-01'], new Set(), '2030-01-01', 'p', 5).fingerprint
    expect(planNights(['2030-06-01'], new Set(), '2030-01-01', 'p', 6).fingerprint).not.toBe(a)
    expect(planNights(['2030-06-01', '2030-06-02'], new Set(), '2030-01-01', 'p', 5).fingerprint).not.toBe(a)
    expect(planNights(['2030-06-01'], new Set(), '2030-01-01', 'p', 5).fingerprint).toBe(a)
  })
})
