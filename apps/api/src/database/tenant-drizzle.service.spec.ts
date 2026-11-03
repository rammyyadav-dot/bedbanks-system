import { Logger } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import type { Pool, PoolClient } from 'pg'
import { runWithTenant, TENANT_REQUIRED } from './tenant-session'
import { TenantDrizzleService } from './tenant-drizzle.service'

describe('TenantDrizzleService', () => {
  const previousGuard = process.env.DB_RUNTIME_ROLE_GUARD

  afterEach(() => {
    if (previousGuard === undefined) delete process.env.DB_RUNTIME_ROLE_GUARD
    else process.env.DB_RUNTIME_ROLE_GUARD = previousGuard
  })

  it('refuses an owner login before opening a pool, without echoing the password', async () => {
    process.env.DB_RUNTIME_ROLE_GUARD = 'enforce'
    const service = new TenantDrizzleService({ connectionString: 'postgresql://neondb_owner:secret-password@127.0.0.1:1/fbeds' })
    await expect(service.client()).rejects.toThrow(/restricted login|owner or administrator/)
    await expect(service.client()).rejects.not.toThrow(/secret-password/)
    try {
      await service.client()
    } catch (error) {
      expect(String(error)).not.toContain('secret-password')
    }
  })

  it('does not connect until a database is requested, and closes a pool it opened', async () => {
    process.env.DB_RUNTIME_ROLE_GUARD = 'off'
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const service = new TenantDrizzleService({ connectionString: 'postgresql://app:secret-password@ep-x-pooler.eu.aws.neon.tech/fbeds' })
    expect(warn).not.toHaveBeenCalled()
    await service.client()
    expect(warn.mock.calls.flat().join(' ')).toMatch(/pgbouncer=true/)
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-password')
    await service.onModuleDestroy()
    warn.mockRestore()
  })

  it('fails closed when the live role can bypass row level security', async () => {
    process.env.DB_RUNTIME_ROLE_GUARD = 'enforce'
    const release = jest.fn()
    const client = {
      query: async () => ({
        rows: [{
          current_user: 'fbeds_api_login',
          session_user: 'fbeds_api_login',
          rolsuper: false,
          rolbypassrls: true,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          owned: 0,
          privileged: null,
        }],
      }),
      release,
    }
    const pool = { connect: async () => client, end: jest.fn() }
    const service = new TenantDrizzleService({
      connectionString: 'postgresql://fbeds_api_login:secret-password@127.0.0.1:1/fbeds',
      pool: pool as unknown as Pool,
    })
    await expect(service.client()).rejects.toThrow(/BYPASSRLS/)
    expect(release).toHaveBeenCalled()
    expect(JSON.stringify(release.mock.calls)).not.toContain('secret-password')
    await expect(service.client()).rejects.toThrow(/BYPASSRLS/)
  })

  it('runs a Drizzle statement on an injected pool only after the tenant scope exists', async () => {
    process.env.DB_RUNTIME_ROLE_GUARD = 'off'
    const calls: string[] = []
    const client = {
      query: async (config: unknown) => {
        calls.push(typeof config === 'string' ? config : String((config as { text?: string }).text))
        return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }
      },
      release: jest.fn(),
    } as unknown as PoolClient
    const service = new TenantDrizzleService({ pool: client as unknown as Pool })
    const db = await service.client()
    const error = await db.execute(sql`select 1`).then(() => undefined, (caught: unknown) => caught)
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    expect(`${error instanceof Error ? error.message : ''}\n${cause}`).toContain(TENANT_REQUIRED)
    expect(calls).toEqual([])
    await runWithTenant('tenant-a', () => db.execute(sql`select 1`))
    expect(calls.some((text) => text.startsWith('SELECT set_config'))).toBe(true)
  })
})
