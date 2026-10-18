import { LedgerIntegritySweeper } from './ledger-integrity-sweeper.service'

type Outcome = 'recorded' | 'exists' | 'busy'
const make = (env: Record<string, string | undefined>, opts: { tenants?: string[]; outcomes?: Record<string, Outcome | Error>; latest?: { status: string; errors: number; warnings: number } } = {}) => {
  const recordRun = jest.fn(async (tenantId: string) => { const o = opts.outcomes?.[tenantId] ?? 'recorded'; if (o instanceof Error) throw o; return o })
  const audit = { assertReady: jest.fn().mockResolvedValue(undefined), listActiveTenantIds: jest.fn().mockResolvedValue(opts.tenants ?? ['t1', 't2']) }
  const runs = { recordRun, list: jest.fn().mockResolvedValue({ latest: opts.latest ?? { status: 'PASS', errors: 0, warnings: 0 } }) }
  const sweeper = new LedgerIntegritySweeper(audit as never, runs as never, env)
  return { sweeper, audit, runs, recordRun }
}
const ENABLED = { LEDGER_INTEGRITY_SWEEP_ENABLED: 'true', LEDGER_AUDIT_DATABASE_URL: 'postgresql://audit@h/db', DATABASE_URL: 'postgresql://web@h/db' }
const AFTER_SLOT = new Date('2026-10-18T05:00:00Z')
const BEFORE_SLOT = new Date('2026-10-18T00:30:00Z')

describe('LedgerIntegritySweeper', () => {
  it('does nothing and needs no credential when disabled', async () => {
    const { sweeper, audit } = make({})
    await sweeper.onModuleInit()
    expect(await sweeper.runOnce(AFTER_SLOT)).toBe(0)
    expect(audit.listActiveTenantIds).not.toHaveBeenCalled()
  })

  it('refuses to start without its own credential, with the web credential, or with a bad hour or interval', async () => {
    await expect(make({ LEDGER_INTEGRITY_SWEEP_ENABLED: 'true' }).sweeper.onModuleInit()).rejects.toThrow(/LEDGER_AUDIT_DATABASE_URL/)
    await expect(make({ ...ENABLED, DATABASE_URL: ENABLED.LEDGER_AUDIT_DATABASE_URL }).sweeper.onModuleInit()).rejects.toThrow(/different credential/)
    await expect(make({ ...ENABLED, LEDGER_INTEGRITY_RUN_HOUR_UTC: '24' }).sweeper.onModuleInit()).rejects.toThrow(/0 to 23/)
    await expect(make({ ...ENABLED, LEDGER_INTEGRITY_CHECK_INTERVAL_MS: '10' }).sweeper.onModuleInit()).rejects.toThrow(/>= 5000/)
  })

  it('stops startup when the credential is not a restricted login', async () => {
    const { sweeper, audit } = make(ENABLED)
    audit.assertReady.mockRejectedValue(new Error('RuntimeRoleViolation'))
    await expect(sweeper.onModuleInit()).rejects.toThrow('RuntimeRoleViolation')
    expect(await sweeper.runOnce(AFTER_SLOT)).toBe(0)
  })

  it('waits for the scheduled hour, then records every tenant once and not again', async () => {
    const { sweeper, recordRun } = make({ ...ENABLED, LEDGER_INTEGRITY_CHECK_INTERVAL_MS: '3600000' })
    await sweeper.onModuleInit()
    expect(await sweeper.runOnce(BEFORE_SLOT)).toBe(0)
    expect(recordRun).not.toHaveBeenCalled()
    expect(await sweeper.runOnce(AFTER_SLOT)).toBe(2)
    expect(await sweeper.runOnce(new Date('2026-10-18T05:05:00Z'))).toBe(0)
    expect(recordRun).toHaveBeenCalledTimes(2) // covered tenants cost nothing on later ticks
    expect(await sweeper.runOnce(new Date('2026-10-19T01:00:00Z'))).toBe(2) // a new UTC date starts afresh
    await sweeper.onModuleDestroy()
  })

  it('a failing tenant is logged and does not stop the others; a busy tenant is retried next tick', async () => {
    const { sweeper, recordRun } = make(ENABLED, { tenants: ['bad', 'busy', 'ok'], outcomes: { bad: new Error('boom'), busy: 'busy' } })
    await sweeper.onModuleInit()
    expect(await sweeper.runOnce(AFTER_SLOT)).toBe(1)
    recordRun.mockClear()
    await sweeper.runOnce(new Date('2026-10-18T05:05:00Z'))
    expect(recordRun.mock.calls.map(c => c[0]).sort()).toEqual(['bad', 'busy']) // ok is done; the other two are tried again
    await sweeper.onModuleDestroy()
  })

  it('never overlaps itself', async () => {
    const { sweeper, audit } = make(ENABLED)
    await sweeper.onModuleInit()
    let release!: () => void
    audit.listActiveTenantIds.mockReturnValueOnce(new Promise<string[]>(resolve => { release = () => resolve(['t1']) }))
    const first = sweeper.runOnce(AFTER_SLOT)
    expect(await sweeper.runOnce(AFTER_SLOT)).toBe(0)
    release()
    expect(await first).toBe(1)
    await sweeper.onModuleDestroy()
  })

  it('a tenant list failure is survived and the next pass can run', async () => {
    const { sweeper, audit } = make(ENABLED)
    await sweeper.onModuleInit()
    audit.listActiveTenantIds.mockRejectedValueOnce(new Error('down'))
    expect(await sweeper.runOnce(AFTER_SLOT)).toBe(0)
    expect(await sweeper.runOnce(AFTER_SLOT)).toBe(2)
    await sweeper.onModuleDestroy()
  })
})
