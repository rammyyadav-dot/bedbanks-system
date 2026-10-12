import { RATE_PLAN_EXPIRY_BATCH_SIZE, RatePlanExpirySweeper, type RatePlanExpiryRuntime, expireDueInTransaction } from './rate-plan-expiry-sweeper.service'

const runtime = (over: Partial<RatePlanExpiryRuntime> = {}): RatePlanExpiryRuntime => ({ listActiveTenantIds: async () => ['t1', 't2'], expireDue: async () => 0, ...over })
const enabled = { RATE_PLAN_EXPIRY_SWEEP_ENABLED: 'true' }

describe('RatePlanExpirySweeper (ADR 0057, S9)', () => {
  it('is disabled by default: it never starts a timer or touches a database', () => {
    const sweeper = new RatePlanExpirySweeper(undefined, {}, runtime())
    expect(() => sweeper.onModuleInit()).not.toThrow()
    sweeper.onModuleDestroy()
  })
  it('refuses to start enabled without the lifecycle credential, and with a bad interval', () => {
    expect(() => new RatePlanExpirySweeper({ configured: () => false } as never, enabled).onModuleInit()).toThrow(/RATE_PLAN_OPS_DATABASE_URL/)
    expect(() => new RatePlanExpirySweeper(undefined, { ...enabled, RATE_PLAN_EXPIRY_SWEEP_INTERVAL_MS: '1000' }, runtime()).onModuleInit()).toThrow(/INTERVAL/)
    expect(() => new RatePlanExpirySweeper(undefined, { ...enabled, RATE_PLAN_EXPIRY_SWEEP_INTERVAL_MS: 'x' }, runtime()).onModuleInit()).toThrow(/INTERVAL/)
  })
  it('visits every active tenant and sums the plans it expired', async () => {
    const calls: string[] = []
    const sweeper = new RatePlanExpirySweeper(undefined, {}, runtime({ expireDue: async (tenantId) => { calls.push(tenantId); return tenantId === 't1' ? 2 : 1 } }))
    expect(await sweeper.runOnce()).toBe(3)
    expect(calls).toEqual(['t1', 't2'])
  })
  it('keeps draining a tenant while full batches come back', async () => {
    const counts = [RATE_PLAN_EXPIRY_BATCH_SIZE, RATE_PLAN_EXPIRY_BATCH_SIZE, 5]
    const sweeper = new RatePlanExpirySweeper(undefined, {}, runtime({ listActiveTenantIds: async () => ['t1'], expireDue: async () => counts.shift() ?? 0 }))
    expect(await sweeper.runOnce()).toBe(RATE_PLAN_EXPIRY_BATCH_SIZE * 2 + 5)
  })
  it('one failing tenant does not stop the others, and the error text is not leaked', async () => {
    const sweeper = new RatePlanExpirySweeper(undefined, {}, runtime({ expireDue: async (tenantId) => { if (tenantId === 't1') throw new Error('postgresql://secret@host/db'); return 4 } }))
    const logged: string[] = []
    ;(sweeper as unknown as { logger: { error: (m: string) => void; log: () => void } }).logger = { error: (m) => logged.push(m), log: () => undefined }
    expect(await sweeper.runOnce()).toBe(4)
    expect(logged.join(' ')).not.toContain('secret')
  })
  it('a pass never overlaps itself', async () => {
    let release: () => void = () => undefined
    const sweeper = new RatePlanExpirySweeper(undefined, {}, runtime({ listActiveTenantIds: async () => ['t1'], expireDue: () => new Promise<number>((resolve) => { release = () => resolve(0) }) }))
    const first = sweeper.runOnce()
    expect(await sweeper.runOnce()).toBe(0)
    release(); await first
  })
  it('does nothing without a runtime', async () => { expect(await new RatePlanExpirySweeper(undefined, {}).runOnce()).toBe(0) })
})

describe('expireDueInTransaction', () => {
  const plan = (over: Record<string, unknown>) => ({ id: 'p', status: 'ACTIVE', updatedAt: new Date('2026-01-01'), validTo: null, contract: { validTo: new Date('2026-12-31T00:00:00Z') }, roomType: { hotel: { timeZone: 'Asia/Dubai' } }, ...over })
  const tx = (plans: unknown[], count = 1) => ({ ratePlan: { findMany: jest.fn().mockResolvedValue(plans), updateMany: jest.fn().mockResolvedValue({ count }) }, auditEvent: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } })
  const now = new Date('2026-10-12T08:00:00Z')

  it('expires an ended plan conditionally on the row it read, writing a SYSTEM audit event with the reason', async () => {
    const t = tx([plan({ validTo: new Date('2026-10-11T00:00:00Z') })])
    expect(await expireDueInTransaction(t as never, 'tenant', now)).toBe(1)
    expect(t.ratePlan.updateMany).toHaveBeenCalledWith({ where: { id: 'p', tenantId: 'tenant', status: 'ACTIVE', updatedAt: new Date('2026-01-01') }, data: { status: 'EXPIRED' } })
    expect(t.auditEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ actorType: 'SYSTEM', action: 'supply.rate_plan.status_changed', payload: expect.objectContaining({ after: { status: 'EXPIRED' }, reason: 'SALE_WINDOW_ENDED', source: 'expiry_sweeper' }) })] })
  })
  it('leaves a plan that is still on sale, and one whose hotel has no valid zone, alone', async () => {
    const t = tx([plan({}), plan({ id: 'q', validTo: new Date('2026-10-01T00:00:00Z'), roomType: { hotel: { timeZone: 'Nowhere/Land' } } })])
    expect(await expireDueInTransaction(t as never, 'tenant', now)).toBe(0)
    expect(t.ratePlan.updateMany).not.toHaveBeenCalled()
  })
  it('writes no audit event when the plan changed under it', async () => {
    const t = tx([plan({ validTo: new Date('2026-10-01T00:00:00Z') })], 0)
    expect(await expireDueInTransaction(t as never, 'tenant', now)).toBe(0)
    expect(t.auditEvent.createMany).not.toHaveBeenCalled()
  })
  it('only ever sets EXPIRED', async () => {
    const t = tx([plan({ validTo: new Date('2026-10-01T00:00:00Z') })])
    await expireDueInTransaction(t as never, 'tenant', now)
    expect((t.ratePlan.updateMany.mock.calls[0][0] as { data: unknown }).data).toEqual({ status: 'EXPIRED' })
  })
})
