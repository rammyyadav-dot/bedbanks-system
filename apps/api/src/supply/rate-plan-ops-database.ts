import { Injectable, Logger, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { databaseErrorCode, isDatabasePermissionDenied } from '../database/db-errors'
import { PrismaService } from '../database/prisma.service'
import { RuntimeRoleViolation } from '../database/runtime-db-identity'

const UNAVAILABLE = 'Rate plan status changes are not available: the lifecycle database role is not configured or lacks a grant. See ADR 0041.'

/**
 * The connection that writes `RatePlan.status` (ADR 0041 Amendment 2), as the narrow role in `database/rate-plan-ops-role.ts`.
 *
 * When `RATE_PLAN_OPS_DATABASE_URL` is set (and differs from `DATABASE_URL`) the lifecycle transaction runs here. When it is not set the
 * caller keeps using the HTTP client, exactly as before this role existed: a strict runtime login is then refused by the database itself
 * (403 RUNTIME_ROLE_OPERATION_PROHIBITED) and an owner connection in a disposable environment works. A configured connection never falls back
 * to the HTTP client: a refused connection or missing grant is a sanitized 503, and nothing from the URL or the database error is returned.
 */
@Injectable()
export class RatePlanOpsDatabase implements OnModuleDestroy {
  private readonly logger = new Logger(RatePlanOpsDatabase.name)
  private client: PrismaService | null = null
  private verified = false
  private readonly env: Record<string, string | undefined>

  constructor(@Optional() env?: Record<string, string | undefined>) { this.env = env ?? process.env }

  configured(): boolean {
    const url = this.env.RATE_PLAN_OPS_DATABASE_URL
    return Boolean(url) && url !== this.env.DATABASE_URL
  }

  private async connection(): Promise<PrismaService> {
    this.client ??= new PrismaService({ datasourceUrl: this.env.RATE_PLAN_OPS_DATABASE_URL as string })
    if (!this.verified) {
      try { await this.client.assertRestrictedRuntimeRole('Rate plan lifecycle'); this.verified = true } catch (error) {
        this.client = null
        if (!(error instanceof RuntimeRoleViolation)) throw error
        this.logger.error(error.message)
        throw new ServiceUnavailableException({ message: UNAVAILABLE, code: 'RATE_PLAN_OPS_UNAVAILABLE' })
      }
    }
    return this.client
  }

  /** Serializable, tenant-scoped. Caller must have authenticated the user and checked `supply.rates.manage` before calling. */
  async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.connection()
    try {
      return await client.withTenant(tenantId, work, { isolationLevel: 'Serializable' })
    } catch (error) {
      const e = error as { name?: string; code?: string }
      if (isDatabasePermissionDenied(error) || e?.name === 'PrismaClientInitializationError' || ['P1000', 'P1001', 'P1002', 'P1010', 'P1017'].includes(e?.code ?? '')) {
        this.logger.error(`Rate plan lifecycle connection refused or lacks a grant (${databaseErrorCode(error)})`)
        throw new ServiceUnavailableException({ message: UNAVAILABLE, code: 'RATE_PLAN_OPS_UNAVAILABLE' })
      }
      throw error
    }
  }

  async onModuleDestroy(): Promise<void> { await this.client?.$disconnect(); this.client = null }
}
