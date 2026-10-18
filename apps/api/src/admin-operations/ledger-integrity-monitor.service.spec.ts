import type { LedgerIntegrityReport, LedgerIntegrityVerdict } from '@bedbanks/contracts'
import { LedgerIntegrityMonitor, type LedgerIntegrityRuntime } from './ledger-integrity-monitor.service'

const report = (verdict: LedgerIntegrityVerdict): LedgerIntegrityReport => ({
  generatedAt: '2026-10-18T00:00:00.000Z', verdict, staleReservationMinutes: 60,
  scan: { accounts: 1, entries: 1, bookings: 0, receipts: 0, entryLimit: 50_000, capped: verdict === 'INCOMPLETE' },
  counts: verdict === 'ISSUES' ? { critical: 1, warning: 0, byCode: [{ code: 'CANCELLED_REFUND_NOT_POSTED', severity: 'critical', count: 1 }] } : { critical: 0, warning: 0, byCode: [] },
  totals: [], findings: [], findingsTruncated: false, definitions: {},
})

function runtime(verdicts: Record<string, LedgerIntegrityVerdict | Error>, extra: Partial<LedgerIntegrityRuntime> = {}): LedgerIntegrityRuntime & { closed: boolean } {
  const r = {
    closed: false,
    listActiveTenantIds: async () => Object.keys(verdicts),
    report: async (tenantId: string) => { const v = verdicts[tenantId]; if (v instanceof Error) throw v; return report(v) },
    close: async () => { r.closed = true },
    ...extra,
  }
  return r
}
const enabled = { LEDGER_INTEGRITY_MONITOR_ENABLED: 'true', LEDGER_INTEGRITY_DATABASE_URL: 'postgresql://monitor@db/x', DATABASE_URL: 'postgresql://api@db/x' }

describe('LedgerIntegrityMonitor (ADR 0069)', () => {
  it('is off by default and does nothing without being enabled', async () => {
    const create = jest.fn()
    const m = new LedgerIntegrityMonitor({}, create)
    await m.onModuleInit()
    expect(create).not.toHaveBeenCalled()
    expect(await m.runOnce()).toEqual({ tenants: 0, clean: 0, warnings: 0, issues: 0, incomplete: 0, failed: 0 })
  })

  it('needs its own credential, never the HTTP one, and an interval of at least an hour', async () => {
    await expect(new LedgerIntegrityMonitor({ LEDGER_INTEGRITY_MONITOR_ENABLED: 'true' }, () => runtime({})).onModuleInit()).rejects.toThrow(/requires LEDGER_INTEGRITY_DATABASE_URL/)
    await expect(new LedgerIntegrityMonitor({ ...enabled, LEDGER_INTEGRITY_DATABASE_URL: enabled.DATABASE_URL }, () => runtime({})).onModuleInit()).rejects.toThrow(/different credential/)
    await expect(new LedgerIntegrityMonitor({ ...enabled, LEDGER_INTEGRITY_MONITOR_INTERVAL_MS: '60000' }, () => runtime({})).onModuleInit()).rejects.toThrow(/>= 3600000/)
  })

  it('stops startup when its credential is not a restricted login, and closes the connection', async () => {
    const r = runtime({}, { verify: async () => { throw new Error('privileged') } })
    await expect(new LedgerIntegrityMonitor(enabled, () => r).onModuleInit()).rejects.toThrow('privileged')
    expect(r.closed).toBe(true)
  })

  it('checks every active tenant, counts each verdict, and one failing tenant does not stop the others', async () => {
    const m = new LedgerIntegrityMonitor(enabled, () => runtime({ a: 'CLEAN', b: 'ISSUES', c: new Error('boom'), d: 'WARNINGS', e: 'INCOMPLETE' }))
    await m.onModuleInit()
    const errors = jest.spyOn((m as unknown as { logger: { error: (s: string) => void } }).logger, 'error').mockImplementation(() => undefined)
    expect(await m.runOnce()).toEqual({ tenants: 5, clean: 1, warnings: 1, issues: 1, incomplete: 1, failed: 1 })
    expect(errors.mock.calls.map(c => c[0])).toEqual(['Ledger integrity ISSUES tenant=b critical=1 warning=0 codes=CANCELLED_REFUND_NOT_POSTED:1', 'Ledger integrity check failed tenant=c error=Error'])
    await m.onModuleDestroy()
  })

  it('never overlaps itself', async () => {
    let release: () => void = () => undefined
    const slow = runtime({ a: 'CLEAN' }, { listActiveTenantIds: () => new Promise(resolve => { release = () => resolve(['a']) }) })
    const m = new LedgerIntegrityMonitor(enabled, () => slow)
    await m.onModuleInit()
    const first = m.runOnce()
    expect(await m.runOnce()).toMatchObject({ tenants: 0 })
    release()
    expect(await first).toMatchObject({ tenants: 1, clean: 1 })
    await m.onModuleDestroy()
  })
})
