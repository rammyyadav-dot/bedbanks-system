import { RATE_PLAN_OPS_PROBES, runRatePlanOpsProbes } from './rate-plan-ops-verify'

const denied = Object.assign(new Error('permission denied for table RatePlan'), { meta: { code: '42501' } })

describe('rate plan lifecycle role probes (ADR 0041 Amendment 2)', () => {
  it('every probe is side-effect free (selects nothing or matches no row)', () => {
    for (const probe of RATE_PLAN_OPS_PROBES) expect(probe.sql).toMatch(/WHERE false$|SELECT 'x' WHERE false$/)
  })

  it('allows exactly one writable surface: RatePlan.status/updated_at and the audit insert', () => {
    const writes = RATE_PLAN_OPS_PROBES.filter((p) => p.expect === 'allowed' && !p.sql.startsWith('SELECT')).map((p) => p.name)
    expect(writes).toEqual(['UPDATE RatePlan.status', 'UPDATE RatePlan.updated_at', 'INSERT AuditEvent'])
  })

  it('passes only when allowed probes run and denied probes fail with insufficient_privilege', async () => {
    const good = { $queryRawUnsafe: async (sql: string) => { if (RATE_PLAN_OPS_PROBES.find((p) => p.sql === sql)?.expect === 'denied') throw denied; return [] }, $executeRawUnsafe: async (sql: string) => { if (RATE_PLAN_OPS_PROBES.find((p) => p.sql === sql)?.expect === 'denied') throw denied; return 0 } }
    expect((await runRatePlanOpsProbes(good as never)).every((r) => r.ok)).toBe(true)
  })

  it('an over-privileged role (a denied probe succeeds) or an unrelated error is a failure', async () => {
    const overPrivileged = { $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 0 }
    expect((await runRatePlanOpsProbes(overPrivileged as never)).some((r) => !r.ok && r.expect === 'denied')).toBe(true)
    const broken = { $queryRawUnsafe: async () => { throw new Error('connection reset') }, $executeRawUnsafe: async () => { throw new Error('connection reset') } }
    expect((await runRatePlanOpsProbes(broken as never)).every((r) => !r.ok)).toBe(true)
  })
})
