import { Injectable, Logger, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { databaseErrorCode, isDatabasePermissionDenied } from '../database/db-errors'
import { PrismaService } from '../database/prisma.service'
import { RuntimeRoleViolation } from '../database/runtime-db-identity'

const NOT_READABLE = 'The ledger audit view is not readable by the API database role. Grants must be reviewed by a human; see ADR 0064.'

/**
 * The nightly ledger integrity run's own database connection (ADR 0064).
 *
 * It connects with `LEDGER_AUDIT_DATABASE_URL` as the dedicated restricted role (see `database/ledger-audit-role.ts`): read the ledger, append its
 * own immutable result and one SYSTEM audit event, nothing else. The same connection serves the Admin history and the live report on a strict
 * deployment, where the ordinary API role has no ledger access at all. Row-level security is not bypassed: every statement runs in a transaction
 * that sets the tenant, exactly like `PrismaService.withTenant`, at REPEATABLE READ so one report sees one consistent snapshot of the ledger.
 *
 * If the URL is missing, equals the HTTP credential, cannot connect, or the role lacks a grant, callers get the sanitized 503
 * `OPERATIONS_READ_DENIED`. It never falls back to a broader principal, and nothing from the connection string or the database error is returned or logged.
 */
@Injectable()
export class LedgerAuditDatabase implements OnModuleDestroy {
  private readonly logger = new Logger(LedgerAuditDatabase.name)
  private client: PrismaService | null = null
  private verified = false
  private readonly env: Record<string, string | undefined>

  constructor(@Optional() env?: Record<string, string | undefined>) { this.env = env ?? process.env }

  /** True when a distinct credential is configured. Says nothing about whether it works. */
  configured(): boolean {
    const url = this.env.LEDGER_AUDIT_DATABASE_URL
    return Boolean(url) && url !== this.env.DATABASE_URL
  }

  private connection(): PrismaService {
    if (!this.configured()) throw new ServiceUnavailableException({ message: NOT_READABLE, code: OPERATIONS_READ_DENIED })
    this.client ??= new PrismaService({ datasourceUrl: this.env.LEDGER_AUDIT_DATABASE_URL as string })
    return this.client
  }

  /** The connection is checked once with the same identity rules as the HTTP client (restricted login only). A violation never degrades to another principal. */
  private async verify(client: PrismaService): Promise<void> {
    if (this.verified) return
    try {
      await client.assertRestrictedRuntimeRole('Ledger audit')
      this.verified = true
    } catch (error) {
      if (!(error instanceof RuntimeRoleViolation)) throw error
      this.logger.error(error.message)
      this.client = null
      throw new ServiceUnavailableException({ message: NOT_READABLE, code: OPERATIONS_READ_DENIED })
    }
  }

  /** Startup identity check for the scheduler, which must refuse to start on a privileged credential. */
  async assertReady(): Promise<void> {
    const client = this.connection()
    await client.assertRestrictedRuntimeRole('Ledger audit')
    this.verified = true
  }

  async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const client = this.connection()
    await this.verify(client)
    try {
      return await client.withTenant(tenantId, work, { isolationLevel: 'RepeatableRead' })
    } catch (error) {
      if (isAccessFailure(error)) {
        this.logger.error(`Ledger audit connection refused or lacks a grant (${databaseErrorCode(error)})`)
        throw new ServiceUnavailableException({ message: NOT_READABLE, code: OPERATIONS_READ_DENIED })
      }
      throw error
    }
  }

  /** Active tenants, ids only. */
  async listActiveTenantIds(): Promise<string[]> {
    const client = this.connection()
    await this.verify(client)
    try {
      return (await client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map(t => t.id)
    } catch (error) {
      if (isAccessFailure(error)) throw new ServiceUnavailableException({ message: NOT_READABLE, code: OPERATIONS_READ_DENIED })
      throw error
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect()
    this.client = null
  }
}

/** A refused connection, bad credential, missing role or missing grant. Anything else (a bug, a constraint) is not an access failure and propagates. */
function isAccessFailure(error: unknown): boolean {
  if (isDatabasePermissionDenied(error)) return true
  const e = error as { name?: string; code?: string }
  return e?.name === 'PrismaClientInitializationError' || (typeof e?.code === 'string' && CONNECTION_CODES.has(e.code))
}
const CONNECTION_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1010', 'P1017'])
