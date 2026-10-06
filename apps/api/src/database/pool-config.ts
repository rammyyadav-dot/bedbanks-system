import { isPooledHost } from './strict-role-rollout'

/**
 * Connection-pool settings for every Prisma client the API creates (ADR 0040).
 *
 * Prisma's default pool is `num_physical_cpus * 2 + 1` PER CLIENT. In a container that number follows the HOST's cores, so one task can open
 * dozens of connections, and the API holds two or three clients (main, booking module, hold-expiry sweeper). Under a burst of search and hold
 * traffic, a few tasks then exhaust PostgreSQL. So the pool is bounded explicitly, and a request that cannot get a connection fails fast
 * (`pool_timeout`) instead of queueing without limit.
 *
 * Rules: a parameter already in the URL always wins (an operator can tune one URL); otherwise the environment fills it; otherwise a safe default.
 * A malformed environment value stops the process at startup rather than being ignored. Nothing here reads, logs or changes credentials.
 *
 *   DB_POOL_MAX                 main API client (default 10)       DB_BOOKING_POOL_MAX   booking module client (default 5)
 *   DB_POOL_TIMEOUT_SECONDS     wait for a free connection (10)    DB_SWEEPER_POOL_MAX   hold-expiry sweeper (default 2)
 *   DB_CONNECT_TIMEOUT_SECONDS  open a new connection (10)         DB_PGBOUNCER=true     transaction-mode pooler in front of the database
 *
 * Behind PgBouncer (transaction mode) Prisma must not use named prepared statements: `pgbouncer=true` turns them off. A host that looks like a
 * pooler endpoint (Neon `-pooler.`, `pgbouncer`) gets it automatically. Tenant context is `set_config(..., true)`, scoped to the transaction,
 * so it is safe under transaction pooling; session-level settings would not be, and none are used.
 */
export interface PoolOptions { maxVar?: string; defaultMax?: number }
export const DEFAULT_POOL_MAX = 10
export const DEFAULT_POOL_TIMEOUT_SECONDS = 10
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10

function bounded(env: Record<string, string | undefined>, name: string, min: number, max: number): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  if (!/^\d{1,4}$/.test(raw.trim())) throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  const value = Number(raw.trim())
  if (value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  return value
}

export function withPoolSettings(rawUrl: string, env: Record<string, string | undefined> = process.env, options: PoolOptions = {}): string {
  let url: URL
  try { url = new URL(rawUrl) } catch { return rawUrl } // let Prisma report a malformed URL in its own words
  const set = (key: string, value: string | number) => { if (!url.searchParams.has(key)) url.searchParams.set(key, String(value)) }
  set('connection_limit', bounded(env, options.maxVar ?? 'DB_POOL_MAX', 1, 200) ?? options.defaultMax ?? DEFAULT_POOL_MAX)
  set('pool_timeout', bounded(env, 'DB_POOL_TIMEOUT_SECONDS', 1, 120) ?? DEFAULT_POOL_TIMEOUT_SECONDS)
  set('connect_timeout', bounded(env, 'DB_CONNECT_TIMEOUT_SECONDS', 1, 120) ?? DEFAULT_CONNECT_TIMEOUT_SECONDS)
  const pooler = env.DB_PGBOUNCER === 'true' || isPooledHost(url.hostname)
  if (pooler) set('pgbouncer', 'true')
  return url.toString()
}

/** A log-safe description of the effective pool (no host, user or password). */
export function describePool(url: string): string {
  try {
    const p = new URL(url).searchParams
    return `max=${p.get('connection_limit') ?? 'prisma-default'} wait=${p.get('pool_timeout') ?? 'default'}s connect=${p.get('connect_timeout') ?? 'default'}s pgbouncer=${p.get('pgbouncer') === 'true'}`
  } catch { return 'unparseable url' }
}
