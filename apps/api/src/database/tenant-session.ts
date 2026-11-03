import { AsyncLocalStorage } from 'node:async_hooks'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { Pool, PoolClient, QueryResult } from 'pg'

/**
 * Transaction-local tenant for Postgres RLS.
 *
 * `fbeds_current_tenant_id()` reads `app.current_tenant_id`. The third argument of
 * `set_config` is `true`, which is `SET LOCAL`: the value dies with the transaction,
 * so a pooled connection cannot carry it into the next request.
 *
 * Drizzle has no query-middleware API. Every statement it sends goes through `pg`
 * `client.query` (a Pool checks a client out and calls the same method). The hook
 * below is that middleware: the setting and the statement share one connection and
 * one transaction.
 */
export const TENANT_SETTING = 'app.current_tenant_id'
export const TENANT_REQUIRED = 'A normalized tenant context is required'
const SET_TENANT_SQL = 'SELECT set_config($1::text, $2::text, $3::boolean)'
const HOOKED = Symbol('fbeds.tenantSession')

const storage = new AsyncLocalStorage<string>()
const checkoutTenant = new WeakMap<PoolClient, string>()

/** Same rule as `PrismaService.withTenant`: a non-empty id with no surrounding whitespace. */
export function isNormalizedTenantId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\u0000\r\n]/.test(value)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
}

/**
 * Runs `fn` with `tenantId` as the tenant Drizzle will pin onto every statement.
 * The id must already have been checked against the caller's membership. This function
 * does not read headers, query strings or request bodies.
 *
 * Drizzle starts a query from the thenable's `.then`, which can run after `storage.run`
 * has returned. Adopting that thenable here calls `.then` before the scope exits, so the
 * query and its awaits keep this tenant.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  if (!isNormalizedTenantId(tenantId)) throw new Error(TENANT_REQUIRED)
  return storage.run(tenantId, () => {
    const result = fn()
    if (!isThenable(result)) return result
    return Promise.resolve(result) as T
  })
}

/** The tenant pinned for the current async scope, or undefined outside `runWithTenant`. */
export function currentTenantId(): string | undefined {
  return storage.getStore()
}

function requireTenantId(): string {
  const tenantId = storage.getStore()
  if (!isNormalizedTenantId(tenantId)) throw new Error(TENANT_REQUIRED)
  return tenantId
}

/**
 * A Pool runs the statement in a later checkout callback. The tenant is captured when
 * `connect` is called, while the async scope is still active, and stored on that client.
 */
function tenantForClient(client: PoolClient): string {
  const pinned = checkoutTenant.get(client)
  const current = storage.getStore()
  if (pinned && isNormalizedTenantId(current) && current !== pinned) throw new Error('Tenant context changed inside a database transaction')
  if (pinned) return pinned
  return requireTenantId()
}

type QueryCallback = (error: Error | undefined, result?: QueryResult) => void
type QueryFn = (...args: unknown[]) => Promise<QueryResult> | QueryResult

function statementText(args: unknown[]): string {
  const first = args[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object' && 'text' in first && typeof (first as { text: unknown }).text === 'string') {
    return (first as { text: string }).text
  }
  return ''
}

/** Named prepared statements survive a transaction and break Neon/PgBouncer transaction pooling. RLS only needs the unnamed extended protocol. */
function withoutPreparedName(args: unknown[]): unknown[] {
  const [first, ...rest] = args
  if (!first || typeof first !== 'object' || !('text' in first)) return args
  const config = { ...(first as Record<string, unknown>) }
  delete config.name
  return [config, ...rest]
}

function statementKind(text: string): 'begin' | 'commit' | 'rollback' | 'other' {
  const trimmed = text.trim()
  if (/^begin\b/i.test(trimmed)) return 'begin'
  if (/^commit\b/i.test(trimmed)) return 'commit'
  if (/^rollback\s+to\b/i.test(trimmed)) return 'other'
  if (/^rollback\b/i.test(trimmed)) return 'rollback'
  return 'other'
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('query failed')
}

/**
 * Installs the tenant hook on one pg client. Safe to call again: a second call does not wrap twice.
 * The client must be used by only one Drizzle session at a time (a Pool checkout already guarantees that).
 */
export function hookPgClient(client: PoolClient, resolveTenant: () => string = () => tenantForClient(client)): PoolClient {
  const tagged = client as PoolClient & { [HOOKED]?: boolean }
  if (tagged[HOOKED]) return client
  Object.defineProperty(tagged, HOOKED, { value: true })

  const originalQuery = client.query.bind(client) as QueryFn
  const originalRelease = client.release.bind(client)
  let inTransaction = false
  let boundTenant: string | null = null
  let broken = false

  const applyTenant = async (tenantId: string): Promise<void> => {
    await originalQuery(SET_TENANT_SQL, [TENANT_SETTING, tenantId, true])
    boundTenant = tenantId
  }

  const rollback = async (): Promise<void> => {
    try {
      await originalQuery('ROLLBACK')
    } catch {
      broken = true
    } finally {
      inTransaction = false
      boundTenant = null
    }
  }

  const tenantForStatement = (): string => {
    const tenantId = resolveTenant()
    if (!isNormalizedTenantId(tenantId)) throw new Error(TENANT_REQUIRED)
    if (boundTenant !== null && boundTenant !== tenantId) throw new Error('Tenant context changed inside a database transaction')
    return tenantId
  }

  const execute = async (args: unknown[]): Promise<QueryResult> => {
    const kind = statementKind(statementText(args))
    if (kind === 'begin') {
      if (inTransaction) return originalQuery(...args)
      const tenantId = tenantForStatement()
      const begun = await originalQuery(...args)
      try {
        await applyTenant(tenantId)
        inTransaction = true
        return begun
      } catch (error) {
        await rollback()
        throw error
      }
    }
    if (kind === 'commit' || kind === 'rollback') {
      // Always finish the transaction that was pinned at BEGIN. A later statement already
      // refused a tenant switch; rollback must still reach the server or the connection
      // would return to the pool inside that transaction.
      try {
        return await originalQuery(...args)
      } finally {
        inTransaction = false
        boundTenant = null
      }
    }
    if (inTransaction) {
      tenantForStatement()
      return originalQuery(...withoutPreparedName(args))
    }

    const tenantId = tenantForStatement()
    await originalQuery('BEGIN')
    try {
      await applyTenant(tenantId)
      inTransaction = true
      const result = await originalQuery(...withoutPreparedName(args))
      await originalQuery('COMMIT')
      inTransaction = false
      boundTenant = null
      return result
    } catch (error) {
      await rollback()
      throw error
    }
  }

  client.query = ((...incoming: unknown[]) => {
    const args = [...incoming]
    const last = args[args.length - 1]
    const callback = typeof last === 'function' ? (args.pop() as QueryCallback) : undefined
    const promise = execute(args)
    if (!callback) return promise
    promise.then(
      (result) => callback(undefined, result),
      (error: unknown) => callback(asError(error)),
    )
    return promise.then(() => undefined, () => undefined)
  }) as PoolClient['query']

  client.release = ((err?: boolean | Error) => {
    const dirty = inTransaction || broken
    inTransaction = false
    boundTenant = null
    broken = false
    checkoutTenant.delete(client)
    if (dirty && !err) return originalRelease(new Error('Drizzle tenant session ended before the transaction committed'))
    return originalRelease(err)
  }) as PoolClient['release']

  return client
}

/** Every checkout Drizzle makes, including `pool.query`, receives the tenant hook. */
export function hookPgPool(pool: Pool, resolveTenant: () => string = requireTenantId): Pool {
  const tagged = pool as Pool & { [HOOKED]?: boolean }
  if (tagged[HOOKED]) return pool
  Object.defineProperty(tagged, HOOKED, { value: true })
  const originalConnect = pool.connect.bind(pool) as Pool['connect']
  pool.connect = ((cb?: (err: Error | undefined, client: PoolClient | undefined, done: (release?: boolean | Error) => void) => void) => {
    if (typeof cb === 'function') {
      let tenantId: string
      try {
        tenantId = resolveTenant()
        if (!isNormalizedTenantId(tenantId)) throw new Error(TENANT_REQUIRED)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(TENANT_REQUIRED)
        cb(err, undefined, () => undefined)
        return
      }
      return originalConnect((err, client, done) => {
        if (!err && client) {
          checkoutTenant.set(client, tenantId)
          hookPgClient(client)
        }
        cb(err, client, done)
      })
    }
    const tenantId = resolveTenant()
    if (!isNormalizedTenantId(tenantId)) throw new Error(TENANT_REQUIRED)
    return Promise.resolve(originalConnect()).then((client) => {
      checkoutTenant.set(client, tenantId)
      hookPgClient(client)
      return client
    })
  }) as Pool['connect']
  return pool
}

function isPool(client: Pool | PoolClient): client is Pool {
  return typeof (client as Pool).connect === 'function' && typeof (client as PoolClient).release !== 'function'
}

/** The only supported way to construct a Drizzle client. Queries fail closed until `runWithTenant` has a normalized id. */
export function createTenantDrizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: Pool | PoolClient,
  options?: { schema?: TSchema },
): NodePgDatabase<TSchema> {
  if (isPool(client)) hookPgPool(client)
  else hookPgClient(client)
  return options?.schema ? drizzle(client, { schema: options.schema }) : drizzle(client)
}
