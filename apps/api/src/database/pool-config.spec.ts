import { describePool, withPoolSettings } from './pool-config'

const BASE = 'postgresql://fbeds_api_login:p%40ss@db.internal:5432/fbeds?schema=public'
const params = (url: string) => Object.fromEntries(new URL(url).searchParams)

describe('pool settings for every Prisma client (ADR 0040)', () => {
  it('PC-01: a bare URL gets a bounded pool, a wait limit and a connect limit, and keeps schema and credentials intact', () => {
    const out = withPoolSettings(BASE, {})
    expect(params(out)).toEqual({ schema: 'public', connection_limit: '10', pool_timeout: '10', connect_timeout: '10' })
    const u = new URL(out)
    expect(u.username).toBe('fbeds_api_login'); expect(u.password).toBe('p%40ss'); expect(u.hostname).toBe('db.internal')
  })

  it('PC-02: the environment sets the sizes; the per-client variable and default apply to the booking module and the sweeper', () => {
    const env = { DB_POOL_MAX: '20', DB_POOL_TIMEOUT_SECONDS: '5', DB_BOOKING_POOL_MAX: '3' }
    expect(params(withPoolSettings(BASE, env)).connection_limit).toBe('20')
    expect(params(withPoolSettings(BASE, env, { maxVar: 'DB_BOOKING_POOL_MAX', defaultMax: 5 })).connection_limit).toBe('3')
    expect(params(withPoolSettings(BASE, {}, { maxVar: 'DB_SWEEPER_POOL_MAX', defaultMax: 2 })).connection_limit).toBe('2')
    expect(params(withPoolSettings(BASE, env)).pool_timeout).toBe('5')
  })

  it('PC-03: a value already in the URL always wins', () => {
    const out = withPoolSettings(`${BASE}&connection_limit=4&pool_timeout=30`, { DB_POOL_MAX: '50', DB_POOL_TIMEOUT_SECONDS: '2' })
    expect(params(out)).toMatchObject({ connection_limit: '4', pool_timeout: '30' })
  })

  it('PC-04: a malformed or out-of-range value stops startup instead of being ignored', () => {
    for (const bad of ['abc', '0', '201', '-1', '1.5', '10 connections']) expect(() => withPoolSettings(BASE, { DB_POOL_MAX: bad })).toThrow(/DB_POOL_MAX/)
    expect(() => withPoolSettings(BASE, { DB_POOL_TIMEOUT_SECONDS: '0' })).toThrow(/DB_POOL_TIMEOUT_SECONDS/)
    expect(() => withPoolSettings(BASE, { DB_POOL_MAX: '' })).not.toThrow()
  })

  it('PC-05: behind a transaction pooler Prisma runs without prepared statements; a direct database is never switched', () => {
    expect(params(withPoolSettings(BASE, { DB_PGBOUNCER: 'true' })).pgbouncer).toBe('true')
    expect(params(withPoolSettings('postgresql://u:p@ep-cool-123-pooler.eu-central-1.aws.neon.tech/db', {})).pgbouncer).toBe('true')
    expect(params(withPoolSettings(BASE, {})).pgbouncer).toBeUndefined()
    expect(params(withPoolSettings(BASE, { DB_PGBOUNCER: 'yes' })).pgbouncer).toBeUndefined() // only the exact value
  })

  it('PC-06: a malformed URL is returned unchanged for Prisma to report', () => {
    expect(withPoolSettings('not a url', {})).toBe('not a url')
  })

  it('PC-07: the log description carries sizes only, never a host, user or password', () => {
    const d = describePool(withPoolSettings(BASE, { DB_PGBOUNCER: 'true' }))
    expect(d).toBe('max=10 wait=10s connect=10s pgbouncer=true')
    expect(d).not.toMatch(/fbeds_api_login|p%40ss|db\.internal/)
  })
})
