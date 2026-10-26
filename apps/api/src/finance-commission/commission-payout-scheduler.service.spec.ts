import { CommissionPayoutScheduler, type CommissionSchedulerRuntime, priorCalendarMonth, proposeDueInTenant } from './commission-payout-scheduler.service'
import * as core from './commission-payout-core'
import * as volume from './commission-volume'

const runtime = (over: Partial<CommissionSchedulerRuntime> = {}): CommissionSchedulerRuntime => ({ listActiveTenantIds: async () => ['t1', 't2'], proposeDue: async () => 0, close: async () => undefined, ...over })
const enabled = { COMMISSION_PAYOUT_SCHEDULER_ENABLED: 'true', COMMISSION_SCHEDULER_DATABASE_URL: 'postgres://scheduler@host/db', DATABASE_URL: 'postgres://api@host/db' }

describe('priorCalendarMonth', () => {
  it('is the full calendar month immediately before now, half-open', () => {
    expect(priorCalendarMonth(new Date('2026-10-12T08:00:00Z'))).toEqual({ periodStart: '2026-09-01', periodEnd: '2026-10-01' })
  })
  it('rolls back a year at a January boundary', () => {
    expect(priorCalendarMonth(new Date('2026-01-15T00:00:00Z'))).toEqual({ periodStart: '2025-12-01', periodEnd: '2026-01-01' })
  })
})

describe('CommissionPayoutScheduler', () => {
  it('is disabled by default: it never starts a timer or touches a database', async () => {
    const scheduler = new CommissionPayoutScheduler(undefined, {}, runtime())
    await expect(scheduler.onModuleInit()).resolves.toBeUndefined()
    await scheduler.onModuleDestroy()
  })
  it('refuses to start enabled without the dedicated credential, or with it equal to DATABASE_URL, or without the posting module, each before touching a database', async () => {
    await expect(new CommissionPayoutScheduler(undefined, { COMMISSION_PAYOUT_SCHEDULER_ENABLED: 'true' }).onModuleInit()).rejects.toThrow(/COMMISSION_SCHEDULER_DATABASE_URL/)
    await expect(new CommissionPayoutScheduler(undefined, { ...enabled, COMMISSION_SCHEDULER_DATABASE_URL: enabled.DATABASE_URL }).onModuleInit()).rejects.toThrow(/different credential/)
    await expect(new CommissionPayoutScheduler(undefined, enabled).onModuleInit()).rejects.toThrow(/booking finance posting module/)
  })
  it('refuses a bad interval once a runtime is in place', async () => {
    await expect(new CommissionPayoutScheduler(undefined, { ...enabled, COMMISSION_PAYOUT_SCHEDULER_INTERVAL_MS: '1000' }, runtime()).onModuleInit()).rejects.toThrow(/INTERVAL/)
  })
  it('visits every active tenant and sums what it proposed', async () => {
    const calls: string[] = []
    const scheduler = new CommissionPayoutScheduler(undefined, {}, runtime({ proposeDue: async (tenantId) => { calls.push(tenantId); return tenantId === 't1' ? 2 : 1 } }))
    expect(await scheduler.runOnce()).toBe(3)
    expect(calls).toEqual(['t1', 't2'])
  })
  it('one failing tenant does not stop the others, and the error text is not leaked', async () => {
    const scheduler = new CommissionPayoutScheduler(undefined, {}, runtime({ proposeDue: async (tenantId) => { if (tenantId === 't1') throw new Error('postgres://secret@host/db'); return 1 } }))
    const logged: string[] = []
    ;(scheduler as unknown as { logger: { error: (m: string) => void; log: () => void } }).logger = { error: (m) => logged.push(m), log: () => undefined }
    expect(await scheduler.runOnce()).toBe(1)
    expect(logged.join(' ')).not.toContain('secret')
  })
  it('a pass never overlaps itself', async () => {
    let release: () => void = () => undefined
    const scheduler = new CommissionPayoutScheduler(undefined, {}, runtime({ listActiveTenantIds: async () => ['t1'], proposeDue: () => new Promise<number>((resolve) => { release = () => resolve(0) }) }))
    const first = scheduler.runOnce()
    expect(await scheduler.runOnce()).toBe(0)
    release(); await first
  })
  it('does nothing without a runtime', async () => { expect(await new CommissionPayoutScheduler(undefined, {}).runOnce()).toBe(0) })
})

describe('proposeDueInTenant', () => {
  const now = new Date('2026-10-12T08:00:00Z')

  function fakeTx(over: { agencies?: unknown[]; existing?: unknown; wallets?: unknown[] } = {}) {
    return {
      agency: { findMany: jest.fn().mockResolvedValue(over.agencies ?? [{ id: 'ag1' }]) },
      agencyCommissionPayout: { findFirst: jest.fn().mockResolvedValue(over.existing ?? null) },
      wallet: { findMany: jest.fn().mockResolvedValue(over.wallets ?? [{ currency: 'AED' }]) },
    }
  }

  function scheduler(tx: ReturnType<typeof fakeTx>) {
    return { withTenant: jest.fn(async (_tenantId: string, work: (tx: unknown) => unknown) => work(tx)) }
  }

  afterEach(() => jest.restoreAllMocks())

  it('proposes nothing for an agency that already has a payout for the prior month', async () => {
    const tx = fakeTx({ existing: { id: 'existing' } })
    const createSpy = jest.spyOn(core, 'createCommissionPayoutRow')
    expect(await proposeDueInTenant(scheduler(tx) as never, {} as never, 't1', now)).toBe(0)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('proposes nothing when every wallet currency has zero volume', async () => {
    const tx = fakeTx()
    jest.spyOn(volume, 'commissionGrossBookedVolume').mockResolvedValue(0n)
    const createSpy = jest.spyOn(core, 'createCommissionPayoutRow')
    expect(await proposeDueInTenant(scheduler(tx) as never, {} as never, 't1', now)).toBe(0)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('proposes the agency\'s highest-volume currency as a SYSTEM actor, with a deterministic requestId', async () => {
    const tx = fakeTx({ wallets: [{ currency: 'AED' }, { currency: 'USD' }] })
    jest.spyOn(volume, 'commissionGrossBookedVolume').mockImplementation(async (_tx, _db, _t, _a, currency) => (currency === 'USD' ? 900_000n : 100_000n))
    const createSpy = jest.spyOn(core, 'createCommissionPayoutRow').mockResolvedValue({ id: 'p1' } as never)
    expect(await proposeDueInTenant(scheduler(tx) as never, {} as never, 't1', now)).toBe(1)
    expect(createSpy).toHaveBeenCalledWith(tx, {
      tenantId: 't1', agencyId: 'ag1', periodStart: '2026-09-01', periodEnd: '2026-10-01', currency: 'USD',
      requestId: 'scheduler:ag1:2026-09-01', grossBookedMinor: 900_000n, actor: { kind: 'SYSTEM' },
    })
  })

  it('never proposes twice for the same tenant pass even across several agencies', async () => {
    const tx = fakeTx({ agencies: [{ id: 'ag1' }, { id: 'ag2' }] })
    jest.spyOn(volume, 'commissionGrossBookedVolume').mockResolvedValue(10_000n)
    const createSpy = jest.spyOn(core, 'createCommissionPayoutRow').mockResolvedValue({ id: 'p' } as never)
    expect(await proposeDueInTenant(scheduler(tx) as never, {} as never, 't1', now)).toBe(2)
    expect(createSpy).toHaveBeenCalledTimes(2)
  })
})
