import { Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { databaseErrorCode, isDatabasePermissionDenied } from '../database/db-errors'
import { PrismaService } from '../database/prisma.service'
import { RuntimeRoleViolation } from '../database/runtime-db-identity'

export interface NarrowRoleOptions {
  /** Environment variable holding the credential, for example RATE_PLAN_OPS_DATABASE_URL. Never logged. */
  urlKey: string
  /** Names the connection in log lines and in the identity check. */
  label: string
  /** The sanitized 503 returned when the connection is configured but unusable. */
  unavailable: { message: string; code: string }
  isolation?: Prisma.TransactionIsolationLevel
}

/**
 * A connection to ONE narrow database role (rate plan lifecycle, rate plan clone). When its credential is set (and differs from `DATABASE_URL`)
 * the caller's transaction runs here. A configured connection never falls back to the HTTP client: a refused connection or a missing grant is a
 * sanitized, typed 503, and nothing from the URL or the database error is returned. The first use verifies the principal is a restricted role.
 */
export abstract class NarrowRoleDatabase implements OnModuleDestroy {
  private readonly logger: Logger
  private client: PrismaService | null = null
  private verified = false

  protected constructor(private readonly env: Record<string, string | undefined>, private readonly options: NarrowRoleOptions) { this.logger = new Logger(options.label) }

  configured(): boolean {
    const url = this.env[this.options.urlKey]
    return Boolean(url) && url !== this.env.DATABASE_URL
  }

  private unavailable(): ServiceUnavailableException { return new ServiceUnavailableException({ message: this.options.unavailable.message, code: this.options.unavailable.code }) }

  protected async connection(): Promise<PrismaService> {
    this.client ??= new PrismaService({ datasourceUrl: this.env[this.options.urlKey] as string })
    if (!this.verified) {
      try { await this.client.assertRestrictedRuntimeRole(this.options.label); this.verified = true } catch (error) {
        // Any failure of the first connection (violated invariant, rejected credential, unreachable host) is the same sanitized, retryable 503; never a 500, never a fallback.
        const failed = this.client
        this.client = null
        await failed.$disconnect().catch(() => undefined)
        this.logger.error(error instanceof RuntimeRoleViolation ? error.message : `${this.options.label} connection failed (${databaseErrorCode(error)})`)
        throw this.unavailable()
      }
    }
    return this.client
  }

  /** Tenant-scoped. Caller must have authenticated the user and checked the permission before calling. */
  async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.connection()
    try {
      return await client.withTenant(tenantId, work, this.options.isolation ? { isolationLevel: this.options.isolation } : undefined)
    } catch (error) {
      if (isAccessFailure(error)) {
        this.logger.error(`${this.options.label} connection refused or lacks a grant (${databaseErrorCode(error)})`)
        throw this.unavailable()
      }
      throw error
    }
  }

  /** Runs `work` on the raw client for statements that are not tenant-scoped. Same access-failure handling. */
  protected async onClient<T>(work: (client: PrismaService) => Promise<T>): Promise<T> {
    const client = await this.connection()
    try { return await work(client) } catch (error) {
      if (isAccessFailure(error)) {
        this.logger.error(`${this.options.label} connection refused or lacks a grant (${databaseErrorCode(error)})`)
        throw this.unavailable()
      }
      throw error
    }
  }

  async onModuleDestroy(): Promise<void> { await this.client?.$disconnect(); this.client = null }
}

/** A refused connection, bad credential, missing role or missing grant. Anything else (a bug, a constraint) is not an access failure and propagates. */
function isAccessFailure(error: unknown): boolean {
  if (isDatabasePermissionDenied(error)) return true
  const e = error as { name?: string; code?: string }
  return e?.name === 'PrismaClientInitializationError' || ['P1000', 'P1001', 'P1002', 'P1010', 'P1017'].includes(e?.code ?? '')
}
