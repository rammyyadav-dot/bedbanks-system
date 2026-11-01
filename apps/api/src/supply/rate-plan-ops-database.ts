import { Injectable, Optional } from '@nestjs/common'
import { NarrowRoleDatabase } from './narrow-role-database'

const UNAVAILABLE = 'Rate plan status changes are not available: the lifecycle database role is not configured or lacks a grant. See ADR 0041.'

/**
 * The connection that writes `RatePlan.status` (ADR 0041 Amendment 2), as the narrow role in `database/rate-plan-ops-role.ts`.
 *
 * When `RATE_PLAN_OPS_DATABASE_URL` is set (and differs from `DATABASE_URL`) the lifecycle transaction runs here, Serializable. When it is not set the
 * caller keeps using the HTTP client, exactly as before this role existed: a strict runtime login is then refused by the database itself
 * (403 RUNTIME_ROLE_OPERATION_PROHIBITED) and an owner connection in a disposable environment works. A configured connection never falls back
 * to the HTTP client: see `NarrowRoleDatabase`.
 */
@Injectable()
export class RatePlanOpsDatabase extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'RATE_PLAN_OPS_DATABASE_URL', label: 'Rate plan lifecycle', unavailable: { message: UNAVAILABLE, code: 'RATE_PLAN_OPS_UNAVAILABLE' }, isolation: 'Serializable' })
  }

  /** Active tenant ids, for the expiry sweeper (ADR 0057, S9). Reads `tenants.id` and `status` only, which is all the role may read. */
  listActiveTenantIds(): Promise<string[]> {
    return this.onClient(async (client) => (await client.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, orderBy: { id: 'asc' } })).map((tenant) => tenant.id))
  }
}
