import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { candidateHorizon, expiryReason, hotelToday } from './rate-plan-expiry'
import { RatePlanOpsDatabase } from './rate-plan-ops-database'

export const RATE_PLAN_EXPIRY_BATCH_SIZE = 100
const MIN_INTERVAL_MS = 60_000
const DEFAULT_INTERVAL_MS = 3_600_000

export interface RatePlanExpiryRuntime {
  listActiveTenantIds(): Promise<string[]>
  /** Expires up to a batch of due plans of one tenant and returns how many it changed. */
  expireDue(tenantId: string, now: Date): Promise<number>
}
type Env = Record<string, string | undefined>

/**
 * Marks live rate plans EXPIRED once their sale window or contract term has ended (ADR 0057, S9; pattern of ADR 0005).
 *
 * It writes `RatePlan.status` and SYSTEM audit events, which the HTTP role cannot do, so it is disabled unless `RATE_PLAN_EXPIRY_SWEEP_ENABLED=true`
 * and it runs only on the narrow lifecycle connection (`RATE_PLAN_OPS_DATABASE_URL`), never on the HTTP client and never with a fallback.
 * Nothing it does is needed for correctness of sales: the stay evaluator already refuses a stay outside the window. It keeps the lifecycle state honest.
 */
@Injectable()
export class RatePlanExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RatePlanExpirySweeper.name)
  private timer?: NodeJS.Timeout
  private running = false
  private runtime?: RatePlanExpiryRuntime

  constructor(@Optional() private readonly ops?: RatePlanOpsDatabase, @Optional() private readonly env: Env = process.env, @Optional() runtime?: RatePlanExpiryRuntime) { this.runtime = runtime }

  onModuleInit(): void {
    if (this.env.RATE_PLAN_EXPIRY_SWEEP_ENABLED !== 'true') return
    if (!this.runtime) {
      if (!this.ops?.configured()) throw new Error('RATE_PLAN_EXPIRY_SWEEP_ENABLED requires RATE_PLAN_OPS_DATABASE_URL (a credential different from DATABASE_URL)')
      this.runtime = defaultRuntime(this.ops)
    }
    const interval = Number(this.env.RATE_PLAN_EXPIRY_SWEEP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`RATE_PLAN_EXPIRY_SWEEP_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Rate plan expiry sweeper enabled every ${interval}ms`)
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass over active tenants; never overlaps itself. A failing tenant is logged and does not stop the others. */
  async runOnce(now: Date = new Date()): Promise<number> {
    const runtime = this.runtime
    if (!runtime || this.running) return 0
    this.running = true
    let expired = 0; let failedTenants = 0
    try {
      for (const tenantId of await runtime.listActiveTenantIds()) {
        try { let count: number; do { count = await runtime.expireDue(tenantId, now); expired += count } while (count >= RATE_PLAN_EXPIRY_BATCH_SIZE) } catch (error) {
          failedTenants += 1
          this.logger.error(`Rate plan expiry failed for tenant ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}`)
        }
      }
    } catch (error) {
      this.logger.error(`Rate plan expiry could not list tenants: ${error instanceof Error ? error.name : 'unknown error'}`)
      return expired
    } finally { this.running = false }
    if (expired > 0 || failedTenants > 0) this.logger.log(`Rate plan expiry pass: expired=${expired} failedTenants=${failedTenants}`)
    return expired
  }
}

/** Candidates are selected by date in SQL, then judged in the hotel's calendar in code. A plan whose hotel has no valid zone is left alone. */
export async function expireDueInTransaction(tx: Prisma.TransactionClient, tenantId: string, now: Date): Promise<number> {
  const horizon = new Date(`${candidateHorizon(now)}T00:00:00Z`)
  const candidates = await tx.ratePlan.findMany({
    where: { tenantId, status: { in: ['ACTIVE', 'SUSPENDED'] }, OR: [{ validTo: { lt: horizon } }, { contract: { validTo: { lt: horizon } } }] },
    select: { id: true, status: true, updatedAt: true, validTo: true, contract: { select: { validTo: true } }, roomType: { select: { hotel: { select: { timeZone: true } } } } },
    orderBy: { id: 'asc' }, take: RATE_PLAN_EXPIRY_BATCH_SIZE,
  })
  let changed = 0
  for (const plan of candidates) {
    const today = hotelToday(now, plan.roomType.hotel.timeZone)
    if (!today) continue
    const reason = expiryReason({ status: plan.status, today, planValidTo: plan.validTo ? plan.validTo.toISOString().slice(0, 10) : null, contractValidTo: plan.contract.validTo.toISOString().slice(0, 10) })
    if (!reason) continue
    // Conditional on the row we read: a plan edited or re-activated since is left for the next pass.
    const result = await tx.ratePlan.updateMany({ where: { id: plan.id, tenantId, status: plan.status, updatedAt: plan.updatedAt }, data: { status: 'EXPIRED' } })
    if (result.count !== 1) continue
    await tx.auditEvent.createMany({ data: [{ tenantId, actorType: 'SYSTEM', action: 'supply.rate_plan.status_changed', entityType: 'rate_plan', entityId: plan.id, payload: { before: { status: plan.status }, after: { status: 'EXPIRED' }, reason, source: 'expiry_sweeper' } }] })
    changed += 1
  }
  return changed
}

function defaultRuntime(ops: RatePlanOpsDatabase): RatePlanExpiryRuntime {
  return {
    listActiveTenantIds: () => ops.listActiveTenantIds(),
    expireDue: (tenantId, now) => ops.withTenant(tenantId, (tx) => expireDueInTransaction(tx, tenantId, now)),
  }
}
