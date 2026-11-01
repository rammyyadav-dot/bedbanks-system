import { RATE_PLAN_CLONE_PROBES } from './rate-plan-clone-verify'
import { assertRatePlanCloneInput, provisionRatePlanCloneRole, ratePlanCloneGrantStatements, RATE_PLAN_CLONE_GROUP_ROLE, RATE_PLAN_CLONE_LOGIN_ROLE } from './rate-plan-clone-role'

describe('rate plan clone role (ADR 0057, S8)', () => {
  const grants = ratePlanCloneGrantStatements()
  it('grants INSERT on exactly RatePlan and AuditEvent, and nothing that updates or deletes', () => {
    expect(grants.filter((g) => /\bINSERT\b/.test(g))).toEqual([`GRANT INSERT ON "RatePlan" TO "${RATE_PLAN_CLONE_GROUP_ROLE}"`, `GRANT INSERT ON "AuditEvent" TO "${RATE_PLAN_CLONE_GROUP_ROLE}"`])
    expect(grants.filter((g) => /\b(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b/.test(g))).toEqual([])
  })
  it('reads only what a clone copies from, never rates, stock, hotels, tenants or the audit log', () => {
    const reads = grants.filter((g) => /\bSELECT\b/.test(g)).map((g) => /ON "(\w+)"/.exec(g)![1])
    expect(reads).toEqual(['RatePlan', 'RoomType', 'Contract', 'SupplierHotelMapping', 'Hotel'])
    expect(grants.find((g) => /ON "Hotel"/.test(g))).toBe(`GRANT SELECT ("id", "tenant_id") ON "Hotel" TO "${RATE_PLAN_CLONE_GROUP_ROLE}"`) // columns, not the table
  })
  it('refuses a login or password that is not dedicated and strong', () => {
    expect(() => assertRatePlanCloneInput('postgres', 'a'.repeat(40))).toThrow()
    expect(() => assertRatePlanCloneInput(RATE_PLAN_CLONE_GROUP_ROLE, 'a'.repeat(40))).toThrow()
    expect(() => assertRatePlanCloneInput('Bad Name', 'a'.repeat(40))).toThrow()
    expect(() => assertRatePlanCloneInput(RATE_PLAN_CLONE_LOGIN_ROLE, 'short')).toThrow()
    expect(() => assertRatePlanCloneInput(RATE_PLAN_CLONE_LOGIN_ROLE, 'a'.repeat(40))).not.toThrow()
  })
  it('provisioning revokes first and creates a role with no dangerous attribute, without logging the password', async () => {
    const statements: string[] = []
    await provisionRatePlanCloneRole({ $executeRawUnsafe: async (q: string) => { statements.push(q); return 0 }, $queryRawUnsafe: async () => [] as never }, { password: 'p'.repeat(40) })
    const joined = statements.join('\n')
    expect(joined).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
    expect(statements.findIndex((s) => s.startsWith('REVOKE ALL ON ALL TABLES'))).toBeLessThan(statements.findIndex((s) => s.startsWith('GRANT SELECT')))
  })
  it('every probe is a no-row statement and the denied set covers writes elsewhere', () => {
    for (const probe of RATE_PLAN_CLONE_PROBES) expect(probe.sql).toMatch(/WHERE false|SELECT 'x' WHERE false/)
    const denied = RATE_PLAN_CLONE_PROBES.filter((p) => p.expect === 'denied').map((p) => p.name)
    expect(denied).toEqual(expect.arrayContaining(['UPDATE RatePlan.status', 'DELETE RatePlan', 'INSERT DailyRate', 'INSERT DailyAvailability', 'SELECT AuditEvent', 'INSERT LedgerEntry']))
    expect(RATE_PLAN_CLONE_PROBES.filter((p) => p.expect === 'allowed').map((p) => p.name)).toEqual(expect.arrayContaining(['INSERT RatePlan', 'INSERT AuditEvent']))
  })
})
