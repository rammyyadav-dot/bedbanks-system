import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import type { Request } from 'express'
import { Observable } from 'rxjs'
import { ACTIVE_TENANT_REQUEST_KEY } from '../agent/tenant-context.guard'
import { isNormalizedTenantId, runWithTenant, TENANT_REQUIRED } from './tenant-session'

/**
 * Copies the tenant `TenantContextGuard` already checked onto the async scope
 * Drizzle reads. The interceptor does not look at `x-fbeds-tenant-id`.
 * Routes with no validated tenant (sign-in, health) are unchanged; a Drizzle
 * query there fails closed because no session variable is set.
 */
@Injectable()
export class TenantRlsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>()
    const tenantId = (request as unknown as Record<string, unknown>)[ACTIVE_TENANT_REQUEST_KEY]
    if (tenantId === undefined) return next.handle()
    if (!isNormalizedTenantId(tenantId)) {
      return new Observable((subscriber) => {
        subscriber.error(new Error(TENANT_REQUIRED))
      })
    }
    return new Observable((subscriber) => {
      const subscription = runWithTenant(tenantId, () => next.handle().subscribe(subscriber))
      return () => subscription.unsubscribe()
    })
  }
}
