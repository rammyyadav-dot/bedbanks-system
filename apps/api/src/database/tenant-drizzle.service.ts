import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common'
import { Pool } from 'pg'
import { inspectPoolConfig, TENANT_DRIZZLE_POOL_MAX } from './pool-config'
import { assertRuntimeDbIdentity, checkRuntimeUrl, runtimeGuardMode } from './runtime-db-identity'
import { createTenantDrizzle } from './tenant-session'

type TenantDatabase = ReturnType<typeof createTenantDrizzle>

/**
 * Process-wide Drizzle client for the restricted `DATABASE_URL` login (ADR 0110).
 *
 * The pool is opened on the first query, not at boot, and is capped at
 * `TENANT_DRIZZLE_POOL_MAX` checkouts. That cap is separate from Prisma's
 * `connection_limit` on the same URL. Idle connections close so a task that
 * never calls Drizzle holds none.
 *
 * There is no tenant argument on this service. The session variable comes from
 * `runWithTenant`, which HTTP requests enter only after `TenantContextGuard`
 * has copied a membership-checked id onto the request.
 */
@Injectable()
export class TenantDrizzleService implements OnModuleDestroy {
  private readonly logger = new Logger(TenantDrizzleService.name)
  private pool?: Pool
  private ownedPool = false
  private database?: TenantDatabase
  private opening?: Promise<TenantDatabase>

  constructor(@Optional() private readonly injected?: { connectionString?: string; pool?: Pool }) {}

  client(): Promise<TenantDatabase> {
    if (this.database) return Promise.resolve(this.database)
    this.opening ??= this.open().then((db) => {
      this.database = db
      return db
    }).catch((error: unknown) => {
      this.opening = undefined
      throw error
    })
    return this.opening
  }

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool
    this.pool = undefined
    this.database = undefined
    this.opening = undefined
    if (pool && this.ownedPool) await pool.end().catch(() => undefined)
  }

  private async open(): Promise<TenantDatabase> {
    const url = this.injected?.connectionString ?? process.env.DATABASE_URL
    if (this.injected?.pool) {
      this.pool = this.injected.pool
      this.ownedPool = false
    } else {
      if (!url) throw new Error('Database URL is not set')
      if (runtimeGuardMode() !== 'off') {
        const checked = checkRuntimeUrl(url)
        if (!checked.ok) throw new Error(`Refusing to open the Drizzle tenant pool: ${checked.reason ?? 'the runtime database URL is not a restricted login'}`)
      }
      const pool = new Pool({
        connectionString: url,
        max: TENANT_DRIZZLE_POOL_MAX,
        idleTimeoutMillis: 10_000,
        allowExitOnIdle: true,
        application_name: 'fbeds-drizzle-tenant',
      })
      this.pool = pool
      this.ownedPool = true
      for (const warning of inspectPoolConfig(url).warnings) {
        if (warning.includes('connection_limit')) continue
        this.logger.warn(`DRIZZLE database pool: ${warning}`)
      }
    }

    const pool = this.pool
    if (runtimeGuardMode() !== 'off') {
      const client = await pool.connect()
      try {
        await assertRuntimeDbIdentity({
          $queryRawUnsafe: async <T>(query: string) => (await client.query(query)).rows as T,
        }, 'DRIZZLE')
      } catch (error) {
        client.release(error instanceof Error ? error : new Error('runtime role'))
        if (this.ownedPool) await pool.end().catch(() => undefined)
        this.pool = undefined
        throw error
      }
      client.release()
    }

    return createTenantDrizzle(pool)
  }
}
