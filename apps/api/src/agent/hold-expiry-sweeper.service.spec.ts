import { HOLD_EXPIRY_BATCH_SIZE, HoldExpirySweeper, type HoldExpiryRuntime } from './hold-expiry-sweeper.service'

const runtime = (overrides: Partial<HoldExpiryRuntime> = {}): HoldExpiryRuntime => ({
  listActiveTenantIds: jest.fn().mockResolvedValue(['t1']),
  expireDue: jest.fn().mockResolvedValue(0),
  close: jest.fn().mockResolvedValue(undefined),
  ...overrides,
})
const enabled = { HOLD_EXPIRY_SWEEP_ENABLED: 'true', HOLD_EXPIRY_DATABASE_URL: 'postgresql://bg@localhost/x', DATABASE_URL: 'postgresql://http@localhost/x' }

describe('HoldExpirySweeper', () => {
  afterEach(() => jest.useRealTimers())

  it('is disabled by default and never opens a database runtime', async () => {
    const factory = jest.fn()
    const sweeper = new HoldExpirySweeper({}, factory)
    await sweeper.onModuleInit()
    expect(factory).not.toHaveBeenCalled()
    expect(await sweeper.runOnce()).toBe(0)
  })

  it.each([
    ['no dedicated credential', { HOLD_EXPIRY_SWEEP_ENABLED: 'true', DATABASE_URL: 'x' }],
    ['the HTTP credential reused', { HOLD_EXPIRY_SWEEP_ENABLED: 'true', HOLD_EXPIRY_DATABASE_URL: 'same', DATABASE_URL: 'same' }],
    ['an unsafe interval', { ...enabled, HOLD_EXPIRY_SWEEP_INTERVAL_MS: '10' }],
  ])('refuses to start with %s', async (_name, env) => {
    const factory = jest.fn()
    await expect(new HoldExpirySweeper(env, factory).onModuleInit()).rejects.toThrow()
    expect(factory).not.toHaveBeenCalled()
  })

  it('drains full batches per tenant and continues after a tenant fails', async () => {
    const calls: Record<string, number> = {}
    const expireDue = jest.fn(async (tenantId: string): Promise<number> => {
      if (tenantId === 'bad') throw new Error('boom')
      calls[tenantId] = (calls[tenantId] ?? 0) + 1
      return calls[tenantId] === 1 ? HOLD_EXPIRY_BATCH_SIZE : 3
    })
    const rt = runtime({ listActiveTenantIds: jest.fn().mockResolvedValue(['bad', 'good']), expireDue })
    jest.useFakeTimers()
    const sweeper = new HoldExpirySweeper(enabled, () => rt)
    await sweeper.onModuleInit()
    expect(await sweeper.runOnce()).toBe(HOLD_EXPIRY_BATCH_SIZE + 3)
    expect(expireDue.mock.calls.filter(call => call[0] === 'good')).toHaveLength(2)
    await sweeper.onModuleDestroy()
    expect(rt.close).toHaveBeenCalled()
  })

  it('does not overlap passes', async () => {
    let release!: () => void
    const gate = new Promise<number>(resolve => { release = () => resolve(0) })
    const rt = runtime({ expireDue: jest.fn(() => gate) })
    jest.useFakeTimers()
    const sweeper = new HoldExpirySweeper(enabled, () => rt)
    await sweeper.onModuleInit()
    const first = sweeper.runOnce()
    await Promise.resolve(); await Promise.resolve()
    expect(await sweeper.runOnce()).toBe(0)
    expect(rt.expireDue).toHaveBeenCalledTimes(1)
    release(); await first
    await sweeper.onModuleDestroy()
  })

  it('survives a tenant listing failure', async () => {
    const rt = runtime({ listActiveTenantIds: jest.fn().mockRejectedValue(new Error('down')) })
    jest.useFakeTimers()
    const sweeper = new HoldExpirySweeper(enabled, () => rt)
    await sweeper.onModuleInit()
    await expect(sweeper.runOnce()).resolves.toBe(0)
    await sweeper.onModuleDestroy()
  })
})
