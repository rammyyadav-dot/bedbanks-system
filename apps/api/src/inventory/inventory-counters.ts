import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { rowIsFresh } from '../supply/contracted-sellability'

/**
 * The only place that moves inventory counters (ADR 0030). Every function runs inside the caller's tenant transaction.
 *
 * Which counter a night draws from is decided once, at reservation time, and recorded on the held night (`counterKind`,
 * `poolDayId`). Release, confirmation and cancellation return to that same counter even if the plan joins or leaves a pool
 * afterwards, so a pool can never be credited with stock it did not give.
 *
 * Lock order is always plan row, then pool day. Counter moves are single guarded UPDATEs, so two concurrent holds can never
 * both take the last unit; the database CHECK constraints are the backstop, not the mechanism.
 */

export type CounterKind = 'PLAN_ROW' | 'POOL_DAY' | 'NONE'

export interface NightReservation {
  availabilityId: string
  counterKind: CounterKind
  poolDayId: string | null
}

export interface HeldNight { availabilityId: string; counterKind: CounterKind; poolDayId: string | null; quantity: number }

interface PlanRowLocked {
  id: string
  mode: string
  stop_sell: boolean
  source: string
  fresh_until: Date | null
  pool_id: string | null
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null)

/**
 * Takes `rooms` units for one plan-night. Refuses (ConflictException) when the night is missing, stop-sold, CLOSED, ON_REQUEST,
 * stale, or out of stock. FREE_SALE takes no counter. Never returns a reservation that was not actually secured.
 */
export async function reserveNight(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; ratePlanId: string; stayDate: Date; rooms: number; now?: Date },
): Promise<NightReservation> {
  const now = input.now ?? new Date()
  if (!Number.isSafeInteger(input.rooms) || input.rooms < 1) throw new ConflictException('Inventory unavailable')
  const rows = await tx.$queryRaw<PlanRowLocked[]>(Prisma.sql`
    SELECT da."id", da."inventory_mode"::text AS "mode", da."stop_sell", da."source"::text AS "source", da."fresh_until", rp."inventory_pool_id" AS "pool_id"
      FROM "DailyAvailability" da
      JOIN "RatePlan" rp ON rp."id" = da."rate_plan_id" AND rp."tenant_id" = da."tenant_id"
     WHERE da."tenant_id" = ${input.tenantId} AND da."rate_plan_id" = ${input.ratePlanId} AND da."stay_date" = ${input.stayDate}
       FOR UPDATE OF da
  `)
  if (rows.length !== 1) throw new ConflictException('Inventory unavailable')
  const row = rows[0]
  if (row.stop_sell) throw new ConflictException('Inventory unavailable')
  if (!rowIsFresh(row.source, iso(row.fresh_until), now)) throw new ConflictException('Inventory unavailable')
  if (row.mode === 'FREE_SALE') return { availabilityId: row.id, counterKind: 'NONE', poolDayId: null }
  if (row.mode !== 'ALLOTMENT') throw new ConflictException('Inventory unavailable') // ON_REQUEST and CLOSED never reserve instantly

  if (row.pool_id) {
    const days = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "InventoryPoolDay" pd
         SET "held" = pd."held" + ${input.rooms}, "updated_at" = CURRENT_TIMESTAMP
        FROM "InventoryPool" p
       WHERE pd."tenant_id" = ${input.tenantId} AND pd."pool_id" = ${row.pool_id} AND pd."stay_date" = ${input.stayDate}
         AND p."id" = pd."pool_id" AND p."tenant_id" = pd."tenant_id" AND p."status" = 'ACTIVE'::"InventoryPoolStatus"
         AND (pd."fresh_until" IS NULL AND pd."source" NOT IN ('SUPPLIER_API'::"InventorySource", 'SUPPLIER_FEED'::"InventorySource") OR pd."fresh_until" > ${now})
         AND pd."sold" + pd."held" + ${input.rooms} <= pd."capacity"
      RETURNING pd."id"
    `)
    if (days.length !== 1) throw new ConflictException('Inventory unavailable')
    return { availabilityId: row.id, counterKind: 'POOL_DAY', poolDayId: days[0].id }
  }

  const taken = await tx.$executeRaw(Prisma.sql`
    UPDATE "DailyAvailability"
       SET "held" = "held" + ${input.rooms}, "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = ${row.id} AND "tenant_id" = ${input.tenantId} AND "stop_sell" = false
       AND "sold" + "held" + ${input.rooms} <= "allotment"
  `)
  if (taken !== 1) throw new ConflictException('Inventory unavailable')
  return { availabilityId: row.id, counterKind: 'PLAN_ROW', poolDayId: null }
}

type Move = 'release' | 'confirm' | 'cancel'

/** Moves a held night's units on the counter it was reserved from. Throws ConflictException if the counter is not in the expected state. */
export async function moveNight(tx: Prisma.TransactionClient, tenantId: string, night: HeldNight, move: Move): Promise<void> {
  if (night.counterKind === 'NONE') return
  const q = night.quantity
  let changed: number
  if (night.counterKind === 'POOL_DAY') {
    if (!night.poolDayId) throw new ConflictException('Inventory hold state is inconsistent')
    const id = night.poolDayId
    changed = await tx.$executeRaw(
      move === 'release' ? Prisma.sql`UPDATE "InventoryPoolDay" SET "held" = "held" - ${q}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenant_id" = ${tenantId} AND "held" >= ${q}`
      : move === 'confirm' ? Prisma.sql`UPDATE "InventoryPoolDay" SET "held" = "held" - ${q}, "sold" = "sold" + ${q}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenant_id" = ${tenantId} AND "held" >= ${q}`
      : Prisma.sql`UPDATE "InventoryPoolDay" SET "sold" = "sold" - ${q}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenant_id" = ${tenantId} AND "sold" >= ${q}`,
    )
  } else {
    const id = night.availabilityId
    changed = await tx.$executeRaw(
      move === 'release' ? Prisma.sql`UPDATE "DailyAvailability" SET "held" = "held" - ${q}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenant_id" = ${tenantId} AND "held" >= ${q}`
      : move === 'confirm' ? Prisma.sql`UPDATE "DailyAvailability" SET "held" = "held" - ${q}, "sold" = "sold" + ${q}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenant_id" = ${tenantId} AND "held" >= ${q}`
      : Prisma.sql`UPDATE "DailyAvailability" SET "sold" = "sold" - ${q}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenant_id" = ${tenantId} AND "sold" >= ${q}`,
    )
  }
  if (changed !== 1) throw new ConflictException(move === 'cancel' ? 'Inventory state is inconsistent' : 'Inventory hold state is inconsistent')
}
