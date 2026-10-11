import { ServiceUnavailableException } from '@nestjs/common'
import { RatePlanOpsDatabase } from './rate-plan-ops-database'
import { RATE_PLAN_OPS_FORBIDDEN_TABLES, RATE_PLAN_OPS_UPDATE_COLUMNS, ratePlanOpsGrantStatements, assertRatePlanOpsInput } from '../database/rate-plan-ops-role'

describe('RatePlanOpsDatabase', () => {
  it('is configured only by a distinct URL', () => {
    expect(new RatePlanOpsDatabase({}).configured()).toBe(false)
    expect(new RatePlanOpsDatabase({ RATE_PLAN_OPS_DATABASE_URL: 'postgresql://a@h/db', DATABASE_URL: 'postgresql://a@h/db' }).configured()).toBe(false)
    expect(new RatePlanOpsDatabase({ RATE_PLAN_OPS_DATABASE_URL: 'postgresql://ops@h/db', DATABASE_URL: 'postgresql://api@h/db' }).configured()).toBe(true)
  })

  it('answers an unreachable or refused credential with a sanitized 503, never a fallback', async () => {
    const db = new RatePlanOpsDatabase({ RATE_PLAN_OPS_DATABASE_URL: 'postgresql://ops:secretsecretsecretsecretsecret123@127.0.0.1:1/db', DATABASE_URL: 'postgresql://api@h/db' })
    const error = await db.withTenant('tenant', async () => 'must not run').catch((e: unknown) => e)
    await db.onModuleDestroy()
    expect(error).toBeInstanceOf(ServiceUnavailableException)
    const body = JSON.stringify((error as ServiceUnavailableException).getResponse())
    expect(body).toContain('RATE_PLAN_OPS_UNAVAILABLE')
    expect(body).not.toMatch(/secretsecret|127\.0\.0\.1|postgresql:/)
  })
})

describe('RatePlanOpsDatabase with the runtime identity guard enforced', () => {
  // The identity check connects before any query, so a rejected credential fails there (not in withTenant). Jest runs with the guard off, which hid this.
  const previous = process.env.DB_RUNTIME_ROLE_GUARD
  beforeAll(() => { process.env.DB_RUNTIME_ROLE_GUARD = 'enforce' })
  afterAll(() => { if (previous === undefined) delete process.env.DB_RUNTIME_ROLE_GUARD; else process.env.DB_RUNTIME_ROLE_GUARD = previous })

  it('answers a credential the server cannot accept with the sanitized 503, from the identity check', async () => {
    const db = new RatePlanOpsDatabase({ NODE_ENV: 'development', RATE_PLAN_OPS_DATABASE_URL: 'postgresql://ops:secretsecretsecretsecretsecret123@127.0.0.1:1/db', DATABASE_URL: 'postgresql://api@h/db' })
    const error = await db.withTenant('tenant', async () => 'must not run').catch((e: unknown) => e)
    await db.onModuleDestroy()
    expect(error).toBeInstanceOf(ServiceUnavailableException)
    const body = JSON.stringify((error as ServiceUnavailableException).getResponse())
    expect(body).toContain('RATE_PLAN_OPS_UNAVAILABLE')
    expect(body).not.toMatch(/secretsecret|127\.0\.0\.1|postgresql:|Authentication|invocation/i)
  })
})

describe('rate plan ops role contract', () => {
  const grants = ratePlanOpsGrantStatements().join('\n')
  it('writes exactly RatePlan.status and updated_at, appends audit, and grants no table-wide write', () => {
    expect(RATE_PLAN_OPS_UPDATE_COLUMNS).toEqual({ RatePlan: ['status', 'updated_at'] })
    expect(grants).toContain('GRANT UPDATE ("status", "updated_at") ON "RatePlan"')
    expect(grants).toContain('GRANT INSERT ON "AuditEvent"')
    expect(grants).not.toMatch(/GRANT (ALL|DELETE|TRUNCATE|REFERENCES|TRIGGER)/)
    expect(grants.match(/GRANT UPDATE/g)).toHaveLength(1)
    expect(grants.match(/GRANT INSERT/g)).toHaveLength(1)
  })
  it('never grants a forbidden table, the audit log for reading, or Hotel beyond three columns', () => {
    for (const table of RATE_PLAN_OPS_FORBIDDEN_TABLES) expect(grants).not.toMatch(new RegExp(`GRANT SELECT ON "${table}"`))
    expect(grants).toContain('GRANT SELECT ("id", "tenant_id", "time_zone") ON "Hotel"')
  })
  it('rejects a weak password and a shared login name', () => {
    expect(() => assertRatePlanOpsInput('fbeds_rateplan_ops', 'short')).toThrow()
    expect(() => assertRatePlanOpsInput('fbeds_rateplan_status', 'a'.repeat(40))).toThrow()
    expect(() => assertRatePlanOpsInput('postgres', 'a'.repeat(40))).toThrow()
    expect(() => assertRatePlanOpsInput('fbeds_rateplan_ops', 'a'.repeat(40))).not.toThrow()
  })
})
