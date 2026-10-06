import { Injectable, Logger, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { databaseErrorCode, isDatabasePermissionDenied } from '../database/db-errors'
import { PrismaService } from '../database/prisma.service'

export const BOOKING_OPS_ENV = Symbol('BOOKING_OPS_ENV')

const NOT_READABLE = 'This operations view is not readable by the API database role. Grants must be reviewed by a human; see ADR 0039.'

/**
 * The Admin booking module's own database connection (ADR 0039, owner answer 1).
 *
 * It connects with `BOOKING_OPS_DATABASE_URL` as the dedicated limited role (see `database/booking-ops-role.ts`) and is used by nothing else.
 * Row-level security is not bypassed: every read runs in a transaction that sets the tenant, exactly like `PrismaService.withTenant`.
 *
 * If the URL is missing, equals the HTTP credential, cannot connect, or the role lacks a grant, callers get the existing sanitized 503
 * `OPERATIONS_READ_DENIED`. It never falls back to the API role: "not readable" must never turn into reading with a broader principal, and
 * never into an empty result. Nothing from the connection string or the database error is returned or logged.
 */
@Injectable()
export class BookingOpsDatabase implements OnModuleDestroy {
  private readonly logger = new Logger(BookingOpsDatabase.name)
  private client: PrismaService | null = null
  private readonly env: Record<string, string | undefined>

  constructor(@Optional() env?: Record<string, string | undefined>) { this.env = env ?? process.env }

  /** True when a distinct credential is configured. Says nothing about whether it works. */
  configured(): boolean {
    const url = this.env.BOOKING_OPS_DATABASE_URL
    return Boolean(url) && url !== this.env.DATABASE_URL
  }

  private connection(): PrismaService {
    if (!this.configured()) throw new ServiceUnavailableException({ message: NOT_READABLE, code: OPERATIONS_READ_DENIED })
    this.client ??= new PrismaService({ datasourceUrl: this.env.BOOKING_OPS_DATABASE_URL as string })
    return this.client
  }

  async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const client = this.connection()
    try {
      return await client.withTenant(tenantId, work, { isolationLevel: 'RepeatableRead' })
    } catch (error) {
      if (isAccessFailure(error)) {
        this.logger.error(`Booking module connection refused or lacks a grant (${databaseErrorCode(error)})`)
        throw new ServiceUnavailableException({ message: NOT_READABLE, code: OPERATIONS_READ_DENIED })
      }
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
