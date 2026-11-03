import { EventEmitter } from 'node:events'
import { sql } from 'drizzle-orm'
import { Pool, type PoolClient } from 'pg'
import {
  createTenantDrizzle,
  currentTenantId,
  hookPgClient,
  hookPgPool,
  isNormalizedTenantId,
  runWithTenant,
  TENANT_REQUIRED,
  TENANT_SETTING,
} from './tenant-session'

interface Call { text: string; values?: unknown[]; name?: string }

function scriptedClient(options?: { fail?: (text: string) => boolean }) {
  const calls: Call[] = []
  const client = {
    query: async (config: unknown, values?: unknown[]) => {
      const text = typeof config === 'string' ? config : String((config as { text?: string }).text ?? '')
      const bound = typeof config === 'string' ? values : values ?? (config as { values?: unknown[] }).values
      calls.push({
        text,
        values: bound === undefined ? undefined : [...(bound as unknown[])],
        name: typeof config === 'object' && config !== null && 'name' in config ? String((config as { name?: unknown }).name) : undefined,
      })
      if (options?.fail?.(text)) throw new Error('statement failed')
      return { rows: [{ ok: 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }
    },
    release: jest.fn(),
  }
  return { client: client as unknown as PoolClient, calls, release: client.release }
}

function texts(calls: Call[]): string[] {
  return calls.map((call) => call.text)
}

function thrownText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? error.cause.message : ''
  return `${error.message}\n${cause}`
}

describe('Drizzle tenant session', () => {
  it('rejects a tenant id that is empty or padded', () => {
    expect(isNormalizedTenantId('tenant-a')).toBe(true)
    expect(isNormalizedTenantId('')).toBe(false)
    expect(isNormalizedTenantId(' tenant-a')).toBe(false)
    expect(isNormalizedTenantId('tenant-a\n')).toBe(false)
    expect(() => runWithTenant(' tenant-a', () => undefined)).toThrow(TENANT_REQUIRED)
  })

  it('pins the tenant inside one transaction for a Drizzle statement and binds the id', async () => {
    const { client, calls } = scriptedClient()
    const db = createTenantDrizzle(client)
    await runWithTenant('tenant-a', () => db.execute(sql`select ${'kept'}`))

    expect(texts(calls).filter((text) => text === 'BEGIN')).toHaveLength(1)
    expect(texts(calls).filter((text) => text === 'COMMIT')).toHaveLength(1)
    const setting = calls.find((call) => call.text.startsWith('SELECT set_config'))
    expect(setting).toMatchObject({ text: 'SELECT set_config($1::text, $2::text, $3::boolean)', values: [TENANT_SETTING, 'tenant-a', true] })
    expect(setting?.text).not.toContain('tenant-a')
    expect(calls.some((call) => call.values?.includes('kept'))).toBe(true)
    expect(calls.findIndex((call) => call.text.startsWith('SELECT set_config'))).toBeLessThan(calls.findIndex((call) => call.values?.includes('kept')))
    expect(currentTenantId()).toBeUndefined()
  })

  it('sets the tenant once for every statement inside a Drizzle transaction', async () => {
    const { client, calls } = scriptedClient()
    const db = createTenantDrizzle(client)
    await runWithTenant("tenant-a'; drop table bookings;--", () => db.transaction(async (tx) => {
      await tx.execute(sql`select 1`)
      await tx.execute(sql`select 2`)
    }))

    expect(texts(calls).filter((text) => /^begin\b/i.test(text))).toHaveLength(1)
    expect(calls.filter((call) => call.text.startsWith('SELECT set_config'))).toEqual([
      expect.objectContaining({ values: [TENANT_SETTING, "tenant-a'; drop table bookings;--", true] }),
    ])
    expect(texts(calls).some((text) => text.includes('drop table'))).toBe(false)
    expect(texts(calls).filter((text) => /^commit\b/i.test(text))).toHaveLength(1)
  })

  it('fails closed with no statement when the request has no tenant', async () => {
    const { client, calls } = scriptedClient()
    const db = createTenantDrizzle(client)
    const error = await db.execute(sql`select 1`).then(() => undefined, (caught: unknown) => caught)
    expect(thrownText(error)).toContain(TENANT_REQUIRED)
    expect(calls).toEqual([])
  })

  it('does not run the caller statement when the tenant setting fails, and rolls back', async () => {
    const { client, calls } = scriptedClient({ fail: (text) => text.startsWith('SELECT set_config') })
    hookPgClient(client)
    await expect(runWithTenant('tenant-a', () => client.query('SELECT 1'))).rejects.toThrow('statement failed')
    expect(texts(calls)).toEqual(['BEGIN', 'SELECT set_config($1::text, $2::text, $3::boolean)', 'ROLLBACK'])
  })

  it('rolls back when the caller statement fails and does not echo the tenant', async () => {
    const { client, calls } = scriptedClient({ fail: (text) => text === 'SELECT 1' })
    hookPgClient(client)
    const error = await runWithTenant('super-secret-tenant', () => client.query('SELECT 1')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('statement failed')
    expect((error as Error).message).not.toContain('super-secret-tenant')
    expect(texts(calls)).toEqual(['BEGIN', 'SELECT set_config($1::text, $2::text, $3::boolean)', 'SELECT 1', 'ROLLBACK'])
  })

  it('refuses a statement when the tenant changes inside the transaction, then rolls the transaction back', async () => {
    const { client, calls } = scriptedClient()
    const db = createTenantDrizzle(client)
    const error = await runWithTenant('tenant-a', () => db.transaction(async (tx) => {
      await runWithTenant('tenant-b', () => tx.execute(sql`select 1`))
    })).then(() => undefined, (caught: unknown) => caught)
    expect(thrownText(error)).toContain('Tenant context changed inside a database transaction')
    expect(calls.some((call) => call.values?.includes('tenant-b'))).toBe(false)
    expect(texts(calls).some((text) => /^rollback\b/i.test(text))).toBe(true)

    calls.length = 0
    await runWithTenant('tenant-b', () => client.query('SELECT 2'))
    expect(calls.find((call) => call.text.startsWith('SELECT set_config'))?.values).toEqual([TENANT_SETTING, 'tenant-b', true])
  })

  it('keeps the surrounding transaction open across a savepoint rollback', async () => {
    const { client, calls } = scriptedClient()
    hookPgClient(client)
    await runWithTenant('tenant-a', async () => {
      await client.query('BEGIN')
      await client.query('ROLLBACK TO SAVEPOINT sp1')
      await client.query('SELECT 1')
      await client.query('COMMIT')
    })
    expect(texts(calls)).toEqual([
      'BEGIN',
      'SELECT set_config($1::text, $2::text, $3::boolean)',
      'ROLLBACK TO SAVEPOINT sp1',
      'SELECT 1',
      'COMMIT',
    ])
  })

  it('drops prepared-statement names before they reach the server', async () => {
    const { client, calls } = scriptedClient()
    hookPgClient(client)
    await runWithTenant('tenant-a', () => client.query({ text: 'SELECT 1', name: 'sticky' }))
    const select = calls.find((call) => call.text === 'SELECT 1')
    expect(select?.name).toBeUndefined()
  })

  it('supports the callback form Pool.query uses and still sets the tenant first', async () => {
    const { client, calls } = scriptedClient()
    hookPgClient(client)
    await runWithTenant('tenant-a', () => new Promise<void>((resolve, reject) => {
      client.query('SELECT 1', (error: Error | undefined) => (error ? reject(error) : resolve()))
    }))
    expect(texts(calls)[0]).toBe('BEGIN')
    expect(texts(calls)[1]).toContain('set_config')
    expect(texts(calls)).toContain('SELECT 1')
    expect(texts(calls).at(-1)).toBe('COMMIT')
  })

  it('destroys a connection released while its tenant transaction is still open', async () => {
    const { client, calls, release } = scriptedClient()
    hookPgClient(client)
    await runWithTenant('tenant-a', () => client.query('BEGIN'))
    client.release()
    expect(release).toHaveBeenCalledWith(expect.any(Error))
    expect(String(release.mock.calls[0][0])).not.toContain('tenant-a')
    calls.length = 0
    await runWithTenant('tenant-b', () => client.query('SELECT 1'))
    expect(calls[1]?.values?.[1]).toBe('tenant-b')
  })

  it('keeps the tenant when the pool runs the statement after connect returns', async () => {
    const calls: Call[] = []
    const scripted = new EventEmitter() as EventEmitter & { query: PoolClient['query']; release: () => void }
    scripted.query = (async (config: unknown, values?: unknown[]) => {
      const text = typeof config === 'string' ? config : String((config as { text?: string }).text ?? '')
      calls.push({ text, values: typeof config === 'string' ? values : values })
      return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }
    }) as PoolClient['query']
    scripted.release = () => undefined
    const pool = new Pool({ connectionString: 'postgresql://fbeds_api_login:x@127.0.0.1:1/fbeds', max: 1, idleTimeoutMillis: 10, allowExitOnIdle: true })
    pool.connect = ((cb?: (err: Error | undefined, client: PoolClient, done: () => void) => void) => {
      if (typeof cb === 'function') {
        setImmediate(() => cb(undefined, scripted as unknown as PoolClient, () => undefined))
        return
      }
      return Promise.resolve(scripted as unknown as PoolClient)
    }) as Pool['connect']
    hookPgPool(pool)
    await runWithTenant('tenant-a', () => new Promise<void>((resolve, reject) => {
      pool.query('SELECT 1', (error: Error | undefined) => (error ? reject(error) : resolve()))
    }))
    expect(calls.map((call) => call.text)).toEqual([
      'BEGIN',
      'SELECT set_config($1::text, $2::text, $3::boolean)',
      'SELECT 1',
      'COMMIT',
    ])
    expect(calls[1]?.values).toEqual([TENANT_SETTING, 'tenant-a', true])
    await pool.end()
  })

  it('does not wrap the hook a second time', async () => {
    const { client, calls } = scriptedClient()
    hookPgClient(client)
    hookPgClient(client)
    await runWithTenant('tenant-a', () => client.query('SELECT 1'))
    expect(calls.filter((call) => call.text.startsWith('SELECT set_config'))).toHaveLength(1)
  })
})
