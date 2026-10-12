import { Injectable, Optional } from '@nestjs/common'
import { NarrowRoleDatabase } from './narrow-role-database'

const UNAVAILABLE = 'Rate plan cloning is not available: the clone database role is not configured or lacks a grant. See ADR 0057.'

/**
 * The connection that INSERTs a cloned `RatePlan` (ADR 0057, S8, decision D5), as the narrow role in `database/rate-plan-clone-role.ts`.
 * That role can insert only DRAFT plans with no inventory pool (a database trigger refuses anything else), update and delete nothing, and
 * write no rates. Used by `SupplyService.cloneRatePlan` only, when `RATE_PLAN_CLONE_DATABASE_URL` is set and differs from `DATABASE_URL`.
 */
@Injectable()
export class RatePlanCloneDatabase extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'RATE_PLAN_CLONE_DATABASE_URL', label: 'Rate plan clone', unavailable: { message: UNAVAILABLE, code: 'RATE_PLAN_CLONE_UNAVAILABLE' } })
  }
}
