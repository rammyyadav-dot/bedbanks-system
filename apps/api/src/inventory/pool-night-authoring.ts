/**
 * Owner-run creation of missing pool stock rows (ADR 0036 Amendment 2).
 *
 * The strict API role holds no INSERT on `InventoryPoolDay`, so the Admin editor and Quick Update refuse a night that has no stock row. Creating
 * those rows is pool authoring, a privileged path (ADR 0032). This tool is the controlled way: it runs with the owner credential, never from the
 * API process, previews by default, creates only missing nights (never touches an existing row, `sold` or `held`), is idempotent, and records one
 * immutable audit event per applied run.
 */
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { dayInZone, expandDates } from '../hotel-setup/quick-update-rules'

export const POOL_NIGHT_ACTION = 'inventory.pool.nights_created'
export const POOL_NIGHT_LIMITS = { maxNights: 366, maxCapacity: 9999 } as const
const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface PoolNightRequest { tenantId: string; poolId: string; from: string; to: string; capacity: number; reason: string; actor: string }

export function validateNightRequest(r: Partial<PoolNightRequest>): string[] {
  const errors: string[] = []
  if (!r.tenantId || !/^[A-Za-z0-9_-]{8,64}$/.test(r.tenantId)) errors.push('--tenant must be a tenant id')
  if (!r.poolId || !/^[A-Za-z0-9_-]{8,64}$/.test(r.poolId)) errors.push('--pool must be a pool id')
  if (!r.from || !DAY.test(r.from) || Number.isNaN(Date.parse(r.from))) errors.push('--from must be YYYY-MM-DD')
  if (!r.to || !DAY.test(r.to) || Number.isNaN(Date.parse(r.to))) errors.push('--to must be YYYY-MM-DD')
  if (r.from && r.to && DAY.test(r.from) && DAY.test(r.to)) {
    if (r.to < r.from) errors.push('--to is before --from')
    else if ((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 + 1 > POOL_NIGHT_LIMITS.maxNights) errors.push(`at most ${POOL_NIGHT_LIMITS.maxNights} nights per run`)
  }
  if (!Number.isInteger(r.capacity) || (r.capacity as number) < 0 || (r.capacity as number) > POOL_NIGHT_LIMITS.maxCapacity) errors.push(`--capacity must be a whole number from 0 to ${POOL_NIGHT_LIMITS.maxCapacity}`)
  if (!r.reason || r.reason.trim().length < 3 || r.reason.trim().length > 500) errors.push('--reason must be 3 to 500 characters')
  if (!r.actor || r.actor.trim().length < 3 || r.actor.trim().length > 120) errors.push('--actor (who is running this) must be 3 to 120 characters')
  return errors
}

export interface NightPlan { create: string[]; existing: string[]; past: string[]; fingerprint: string }

/** Pure: which requested nights would be created. Existing rows and nights before the hotel-local today are never written. */
export function planNights(dates: readonly string[], existing: ReadonlySet<string>, today: string, poolId: string, capacity: number): NightPlan {
  const create: string[] = []; const ex: string[] = []; const past: string[] = []
  for (const d of dates) { if (d < today) past.push(d); else if (existing.has(d)) ex.push(d); else create.push(d) }
  return { create, existing: ex, past, fingerprint: createHash('sha256').update(JSON.stringify({ poolId, capacity, create })).digest('hex') }
}

type Tx = Prisma.TransactionClient
type Client = { $transaction<T>(fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> }

export interface NightResult { plan: NightPlan; created: number; applied: boolean; hotelId: string; poolName: string }

/**
 * Previews, or with `apply` creates, the missing nights of one pool. `expectedFingerprint` (from a preview) makes apply refuse if the set of missing
 * nights changed in between. A re-run after a successful apply finds nothing to create and writes nothing.
 */
export async function authorPoolNights(db: Client, req: PoolNightRequest, opts: { apply: boolean; expectedFingerprint?: string; now?: Date }): Promise<NightResult> {
  const errors = validateNightRequest(req)
  if (errors.length) throw new Error(errors.join('; '))
  return db.$transaction(async (tx) => {
    // The operator names the tenant; it is set as the transaction's tenant context so forced RLS applies to this owner session too.
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${req.tenantId}, true)`
    const found = await tx.$queryRaw<Array<{ id: string; tenant_id: string; hotel_id: string; name: string; status: string; time_zone: string }>>`
      SELECT p."id", p."tenant_id", p."hotel_id", p."name", p."status"::text AS "status", h."time_zone"
        FROM "InventoryPool" p JOIN "Hotel" h ON h."id" = p."hotel_id" AND h."tenant_id" = p."tenant_id" WHERE p."id" = ${req.poolId} AND p."tenant_id" = ${req.tenantId}`
    const pool = found[0]
    if (!pool) throw new Error('pool not found in that tenant')
    const tenantId = pool.tenant_id
    if (pool.status !== 'ACTIVE') throw new Error('the pool is not ACTIVE; nights are not added to an archived pool')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quick-update:${tenantId}:${pool.hotel_id}`}))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory:${tenantId}:${pool.hotel_id}`}))`
    const dates = expandDates([{ from: req.from, to: req.to }], [])
    const rows = await tx.$queryRaw<Array<{ d: string }>>`SELECT to_char("stay_date", 'YYYY-MM-DD') AS d FROM "InventoryPoolDay" WHERE "pool_id" = ${req.poolId} AND "tenant_id" = ${tenantId} AND "stay_date" BETWEEN ${req.from}::date AND ${req.to}::date`
    const plan = planNights(dates, new Set(rows.map((r) => r.d)), dayInZone(opts.now ?? new Date(), pool.time_zone), req.poolId, req.capacity)
    if (!opts.apply) return { plan, created: 0, applied: false, hotelId: pool.hotel_id, poolName: pool.name }
    if (opts.expectedFingerprint && opts.expectedFingerprint !== plan.fingerprint) throw new Error('the missing nights changed since the preview; run the preview again')
    if (plan.create.length === 0) return { plan, created: 0, applied: true, hotelId: pool.hotel_id, poolName: pool.name }
    const now = new Date()
    // INSERT only; an existing night is never updated, so sold and held are untouched. ON CONFLICT DO NOTHING covers a writer outside our locks.
    const created = await tx.$executeRaw`
      INSERT INTO "InventoryPoolDay" ("id", "tenant_id", "pool_id", "stay_date", "capacity", "sold", "held", "source", "source_updated_at", "received_at", "fresh_until", "created_at", "updated_at")
      SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || d), 1, 24), ${tenantId}, ${req.poolId}, d::date, ${req.capacity}, 0, 0, 'ADMIN'::"InventorySource", ${now}, ${now}, NULL, ${now}, ${now}
        FROM unnest(${plan.create}::text[]) AS d
      ON CONFLICT ("pool_id", "stay_date") DO NOTHING`
    await tx.$executeRaw`
      INSERT INTO "AuditEvent" ("id", "tenant_id", "user_id", "actor_type", "action", "entity_type", "entity_id", "payload", "created_at")
      VALUES ('c' || substr(md5(random()::text || clock_timestamp()::text), 1, 24), ${tenantId}, NULL, 'SYSTEM'::"AuditActorType", ${POOL_NIGHT_ACTION}, 'hotel', ${pool.hotel_id},
              ${JSON.stringify({ poolId: req.poolId, poolName: pool.name, startDate: req.from, endDate: req.to, capacity: req.capacity, reason: req.reason.trim(), operator: req.actor.trim(), created, skippedExisting: plan.existing.length, skippedPast: plan.past.length, fingerprint: plan.fingerprint, sample: plan.create.slice(0, 20), via: 'ops:pool-nights' })}::jsonb, ${now})`
    return { plan, created: Number(created), applied: true, hotelId: pool.hotel_id, poolName: pool.name }
  }, { timeout: 30_000 })
}
