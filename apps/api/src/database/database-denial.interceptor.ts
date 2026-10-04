import { CallHandler, ExecutionContext, ForbiddenException, Injectable, Logger, NestInterceptor } from '@nestjs/common'
import type { Request } from 'express'
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs'
import { RUNTIME_ROLE_OPERATION_PROHIBITED } from '@bedbanks/contracts'
import { AgentAuditService } from '../agent/audit.service'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import { databaseErrorCode, isDatabasePermissionDenied } from './db-errors'
import { PrismaService } from './prisma.service'
import { inspectRuntimePrivileges } from './api-runtime-role'

const TABLE_IN_MESSAGE = /permission denied for (?:table|relation|view) "?([A-Za-z_][A-Za-z0-9_]*)"?/

/** The table a PostgreSQL 42501 names, or null. The name is used only to compare against the contract and is never returned to a client. */
export function deniedTable(error: unknown): string | null {
  const message = error instanceof Error ? error.message : ''
  return TABLE_IN_MESSAGE.exec(message)?.[1] ?? null
}

/**
 * Turns a database privilege denial on an authorized request into a controlled answer (ADR 0032). It compares the live privileges of the
 * runtime role for the denied table with the contract:
 *  - they MATCH: the role is intentionally not allowed this operation (a privileged path). The request is refused with a typed 403
 *    `RUNTIME_ROLE_OPERATION_PROHIBITED` and an audit event; the transaction already rolled back, so nothing was written.
 *  - they DIFFER: the grants drifted from the contract. That is infrastructure configuration, not a caller decision, so the original error
 *    continues to the global filter, which answers a sanitized 503 DATABASE_ROLE_NOT_PERMITTED with a diagnostic.
 * A denial it cannot attribute to a table is left alone for the filter. Application RBAC has already run before any statement reaches the database.
 */
@Injectable()
export class DatabaseDenialInterceptor implements NestInterceptor {
  private readonly logger = new Logger(DatabaseDenialInterceptor.name)
  constructor(private readonly prisma: PrismaService, private readonly audit: AgentAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => {
      const table = isDatabasePermissionDenied(error) ? deniedTable(error) : null
      if (!table) return throwError(() => error)
      const request = context.switchToHttp().getRequest<Request>()
      return from(this.classify(request, table, error)).pipe(mergeMap((outcome) => throwError(() => outcome ?? error)))
    }))
  }

  private async classify(request: Request, table: string, error: unknown): Promise<ForbiddenException | null> {
    try {
      const { problems } = await inspectRuntimePrivileges(this.prisma, table)
      if (problems.length > 0) {
        this.logger.error(JSON.stringify({ event: 'runtime_role_grant_drift', table, problems: problems.map((p) => p.message), requestId: request.requestId ?? 'unknown' }))
        return null
      }
    } catch (inspectError) {
      this.logger.error(JSON.stringify({ event: 'runtime_role_inspection_failed', dbCode: databaseErrorCode(inspectError), requestId: request.requestId ?? 'unknown' }))
      return null
    }
    await this.recordProhibited(request, table, error)
    return new ForbiddenException({ message: 'This operation is not available through the API runtime. It is performed through the privileged operator path.', code: RUNTIME_ROLE_OPERATION_PROHIBITED })
  }

  private async recordProhibited(request: Request, table: string, error: unknown): Promise<void> {
    const identity = (request as unknown as { user?: AuthenticatedUser }).user
    const tenantId = (request as unknown as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY]
    if (!identity || typeof tenantId !== 'string') return
    try {
      await this.audit.record({
        tenantId, user: identity, action: 'runtime_role.operation_prohibited', entityType: 'runtime_role', entityId: 'api',
        payload: { method: request.method, route: request.route?.path ?? 'unknown', table, dbCode: databaseErrorCode(error), outcome: 'denied', requestId: request.requestId ?? null },
      })
    } catch {
      this.logger.error(JSON.stringify({ event: 'runtime_role_denial_audit_failed', requestId: request.requestId ?? 'unknown' }))
    }
  }
}
