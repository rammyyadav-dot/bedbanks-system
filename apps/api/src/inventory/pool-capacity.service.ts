import { createHash } from 'crypto'
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  POOL_CAPACITY_LIMITS,
  type InventoryPoolDetail, type PoolAttribution, type PoolCapacityApplied, type PoolCapacityApply, type PoolCapacityEditRequest, type PoolCapacityPreview, type PoolConsumptionPlan, type PoolConsumptionReport, type PoolDayDetail,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { idParam } from '../admin-operations/query-params'
import { dayInZone, expandDates } from '../hotel-setup/quick-update-rules'
import { rowIsFresh } from '../supply/contracted-sellability'
import { capacityFingerprint, normaliseCapacityEdit, planCapacityEdit, type NormalisedCapacityEdit, type PoolDayState } from './pool-capacity-rules'
import { attributeNight, type AttributedNight } from './pool-consumption'

type Tx = Prisma.TransactionClient
const KEY = /^[A-Za-z0-9_.:-]{8,80}$/
const MS = 86_400_000
const DEFAULT_DAYS = 30
const DETAIL_MAX_DAYS = 90
const day = (d: Date) => d.toISOString().slice(0, 10)
const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`)
const addDays = (d: string, n: number) => day(new Date(toDate(d).getTime() + n * MS))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export const POOL_CAPACITY_ACTION = 'inventory.pool.capacity_changed'

/**
 * Admin pool detail, per-plan consumption report and the bounded capacity editor (ADR 0036). Built on the existing inventory model:
 * the same `InventoryPoolDay` counters Agent search, recheck and holds use, the same compare-and-set and audit pattern as the pool and
 * Quick Update services, and the same advisory locks. It adds no counter of its own and never touches sold or held.
 */
@Injectable()
export class PoolCapacityService {
  /** Replaceable in tests. */
  clock: () => Date = () => new Date()
  constructor(private readonly prisma: PrismaService) {}

  private async hotel(tx: Tx, tenantId: string, hotelIdRaw: string) {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId }, select: { id: true, name: true, timeZone: true } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    return hotel
  }

  /** The pool, only if it belongs to this tenant AND this hotel. Anything else is a 404 and reveals nothing. */
  private async pool(tx: Tx, tenantId: string, hotelId: string, poolIdRaw: string) {
    const id = idParam('poolId', poolIdRaw)
    if (!id) throw new BadRequestException('Invalid poolId')
    const pool = await tx.inventoryPool.findFirst({ where: { id, tenantId, hotelId }, select: { id: true, name: true, status: true, supplierId: true, updatedAt: true, createdAt: true, archivedAt: true, supplier: { select: { displayName: true } } } })
    if (!pool) throw new NotFoundException('Pool not found')
    return pool
  }

  private window(query: { from?: unknown; days?: unknown }, today: string, defaultDays: number, maxDays: number) {
    const from = typeof query.from === 'string' && query.from !== '' ? query.from : today
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || day(toDate(from)) !== from) throw new BadRequestException('Invalid from')
    const days = query.days === undefined || query.days === '' ? defaultDays : Number(query.days)
    if (!Number.isInteger(days) || days < 1 || days > maxDays) throw new BadRequestException(`Invalid days (1-${maxDays})`)
    const dates = Array.from({ length: days }, (_, i) => addDays(from, i))
    return { from: dates[0], to: dates[dates.length - 1], days, dates }
  }

  private members(tx: Tx, tenantId: string, poolId: string) {
    return tx.ratePlan.findMany({
      where: { tenantId, inventoryPoolId: poolId },
      select: { id: true, code: true, status: true, roomTypeId: true, roomType: { select: { name: true } }, boardBasis: { select: { code: true } }, contract: { select: { code: true } } },
      orderBy: [{ roomType: { name: 'asc' } }, { code: 'asc' }, { id: 'asc' }],
    })
  }

  // ---- detail ------------------------------------------------------------------------------------------------------------------
  async detail(tenantId: string, hotelIdRaw: string, poolIdRaw: string, query: { from?: unknown; days?: unknown }): Promise<InventoryPoolDetail> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const pool = await this.pool(tx, tenantId, hotel.id, poolIdRaw)
      const now = this.clock()
      const today = dayInZone(now, hotel.timeZone)
      const w = this.window(query, today, DEFAULT_DAYS, DETAIL_MAX_DAYS)
      const members = await this.members(tx, tenantId, pool.id)
      const rows = await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: pool.id, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } } })
      const byDate = new Map(rows.map((r) => [day(r.stayDate), r]))
      const days: PoolDayDetail[] = w.dates.map((date) => {
        const d = byDate.get(date)
        if (!d) return { date, exists: false, capacity: null, sold: null, held: null, available: null, stale: false, source: null, freshUntil: null, updatedAt: null }
        return { date, exists: true, capacity: d.capacity, sold: d.sold, held: d.held, available: d.capacity - d.sold - d.held, stale: !rowIsFresh(d.source, d.freshUntil ? d.freshUntil.toISOString() : null, now), source: d.source, freshUntil: d.freshUntil ? d.freshUntil.toISOString() : null, updatedAt: d.updatedAt.toISOString() }
      })
      const rooms = [...new Map(members.map((m) => [m.roomTypeId, { roomTypeId: m.roomTypeId, name: m.roomType.name }])).values()]
      return {
        hotelId: hotel.id, hotelName: hotel.name, timeZone: hotel.timeZone, hotelToday: today, generatedAt: now.toISOString(), window: { from: w.from, to: w.to, days: w.days },
        pool: {
          id: pool.id, name: pool.name, status: pool.status, supplierId: pool.supplierId, supplierName: pool.supplier.displayName, updatedAt: pool.updatedAt.toISOString(),
          members: members.map((m) => ({ ratePlanId: m.id, ratePlanCode: m.code, roomName: m.roomType.name, boardCode: m.boardBasis.code.trim(), contractCode: m.contract.code, planStatus: m.status })),
          missingNights: days.filter((d) => !d.exists).length,
        },
        rooms, days,
        auditNote: 'Pool changes are recorded on the hotel audit trail with this pool id (inventory.pool.* and inventory.pool.capacity_changed). The hotel Audit tab lists them for people holding audit.read.',
      }
    })
  }

  // ---- per-plan consumption ----------------------------------------------------------------------------------------------------
  async consumption(tenantId: string, hotelIdRaw: string, poolIdRaw: string, query: { from?: unknown; days?: unknown }): Promise<PoolConsumptionReport> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const pool = await this.pool(tx, tenantId, hotel.id, poolIdRaw)
      const now = this.clock()
      const w = this.window(query, dayInZone(now, hotel.timeZone), DEFAULT_DAYS, POOL_CAPACITY_LIMITS.reportMaxDays)
      const members = await this.members(tx, tenantId, pool.id)
      const rows = await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: pool.id, stayDate: { gte: toDate(w.from), lte: toDate(w.to) } }, select: { id: true, stayDate: true, capacity: true, sold: true, held: true } })
      const byDate = new Map(rows.map((r) => [day(r.stayDate), r]))
      const dayIds = rows.map((r) => r.id)

      // Counters, lifecycle attribution and membership share one repeatable-read snapshot. Required read failures propagate as operational errors.
      const attribution: PoolAttribution = { state: 'available' }
      let evidence: AttributedNight[] = []
      let formerPlans: Array<{ id: string; code: string; roomName: string; boardCode: string; contractCode: string }> = []
      if (dayIds.length > 0) {
        const read = await (async () => {
          const grouped = await tx.$queryRaw<Array<{ pool_day_id: string; rate_plan_id: string; status: string; qty: number }>>(Prisma.sql`
            SELECT hn."pool_day_id", h."rate_plan_id", h."status"::text AS "status", SUM(hn."quantity")::int AS "qty"
              FROM "InventoryHoldNight" hn
              JOIN "InventoryHold" h ON h."id" = hn."hold_id" AND h."tenant_id" = hn."tenant_id"
             WHERE hn."tenant_id" = ${tenantId} AND hn."counter_kind" = 'POOL_DAY'::"InventoryCounterKind" AND hn."pool_day_id" IN (${Prisma.join(dayIds)})
             GROUP BY hn."pool_day_id", h."rate_plan_id", h."status"
          `)
          const memberIds = new Set(members.map((m) => m.id))
          const other = [...new Set(grouped.map((g) => g.rate_plan_id))].filter((id) => !memberIds.has(id))
          const former = other.length === 0 ? [] : await tx.ratePlan.findMany({ where: { tenantId, id: { in: other } }, select: { id: true, code: true, roomType: { select: { name: true } }, boardBasis: { select: { code: true } }, contract: { select: { code: true } } } })
          return { grouped, former }
        })()
        evidence = read.grouped.map((g) => ({ poolDayId: g.pool_day_id, ratePlanId: g.rate_plan_id, holdStatus: g.status, quantity: Number(g.qty) }))
        formerPlans = read.former.map((f) => ({ id: f.id, code: f.code, roomName: f.roomType.name, boardCode: f.boardBasis.code.trim(), contractCode: f.contract.code }))
      }

      const nights = w.dates.map((date) => {
        const d = byDate.get(date)
        const n = attributeNight(date, d ? { id: d.id, capacity: d.capacity, sold: d.sold, held: d.held } : null, attribution.state === 'available' ? evidence : [])
        return attribution.state === 'available' ? n : { ...n, plans: [], unattributedHeld: null, unattributedSold: null, consistent: null }
      })
      const planRows: PoolConsumptionPlan[] = [
        ...members.map((m) => ({ ratePlanId: m.id, ratePlanCode: m.code, roomName: m.roomType.name, boardCode: m.boardBasis.code.trim(), contractCode: m.contract.code, member: true })),
        ...formerPlans.map((f) => ({ ratePlanId: f.id, ratePlanCode: f.code, roomName: f.roomName, boardCode: f.boardCode, contractCode: f.contractCode, member: false })),
      ].map((p) => attribution.state === 'available'
        ? { ...p, held: nights.reduce((a, n) => a + (n.plans.find((x) => x.ratePlanId === p.ratePlanId)?.held ?? 0), 0), sold: nights.reduce((a, n) => a + (n.plans.find((x) => x.ratePlanId === p.ratePlanId)?.sold ?? 0), 0) }
        : { ...p, held: null, sold: null })
      const withDay = nights.filter((n) => n.exists)
      const known = attribution.state === 'available'
      const sum = (f: (n: (typeof nights)[number]) => number | null) => (known ? withDay.reduce((a, n) => a + (f(n) ?? 0), 0) : null)
      return {
        hotelId: hotel.id, poolId: pool.id, poolName: pool.name, timeZone: hotel.timeZone, generatedAt: now.toISOString(), window: { from: w.from, to: w.to, days: w.days },
        plans: planRows, nights, attribution,
        totals: {
          nightsWithPoolDay: withDay.length, inconsistentNights: known ? withDay.filter((n) => n.consistent === false).length : 0,
          attributedHeld: sum((n) => n.plans.reduce((a, p) => a + p.held, 0)), attributedSold: sum((n) => n.plans.reduce((a, p) => a + p.sold, 0)),
          unattributedHeld: sum((n) => n.unattributedHeld), unattributedSold: sum((n) => n.unattributedSold),
        },
        definitions: {
          counters: 'A pool night has one counter set: capacity, sold and held. available = capacity - sold - held, the expression Agent search and recheck use. Nothing else is subtracted.',
          held: 'Units on holds in status HELD, PROCESSING or HOLD_PENDING (a booking attempt keeps the hold until it confirms or releases).',
          sold: 'Units on holds in status CONFIRMED. A cancelled booking returns its units and its hold becomes RELEASED.',
          excluded: 'RELEASED, EXPIRED, FAILED, PENDING_RECHECK and RECHECKED holds occupy nothing now and are not counted. Cumulative lifecycle events are never shown as current occupancy.',
          attribution: 'Each hold recorded the pool night it drew from and the rate plan that holds it when it was created. Attribution uses those records, not current pool membership, so a plan that later left the pool keeps its history. Unattributed = counter - attributed; it is derived, and a negative value is reported as inconsistent rather than hidden.',
          limitations: [
            'Consumption recorded before holds noted their counter (before ADR 0030) or written to the counter outside the hold path appears only as unattributed.',
            'Nights a plan sold on its own row before it joined a pool are not pool consumption and are not shown here.',
            'Attribution uses required column-only hold reads. Missing grants are operational errors, never zero consumption.',
          ],
        },
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  }

  // ---- capacity editor ---------------------------------------------------------------------------------------------------------
  private async loadDays(tx: Tx, tenantId: string, poolId: string, dates: string[]): Promise<Map<string, PoolDayState>> {
    if (dates.length === 0) return new Map()
    const rows = await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId, stayDate: { in: dates.map(toDate) } }, select: { id: true, stayDate: true, capacity: true, sold: true, held: true, updatedAt: true } })
    return new Map(rows.map((r) => [day(r.stayDate), { id: r.id, capacity: r.capacity, sold: r.sold, held: r.held, updatedAt: r.updatedAt }]))
  }

  private async plan(tx: Tx, tenantId: string, hotel: { id: string; timeZone: string }, poolIdRaw: string, value: NormalisedCapacityEdit) {
    const pool = await this.pool(tx, tenantId, hotel.id, poolIdRaw)
    const today = dayInZone(this.clock(), hotel.timeZone)
    const dates = expandDates([{ from: value.startDate, to: value.endDate }], value.weekdays)
    const days = await this.loadDays(tx, tenantId, pool.id, dates)
    const planned = planCapacityEdit(value, days, today)
    return { pool, today, days, planned, fingerprint: capacityFingerprint({ poolId: pool.id, status: pool.status, value, dates: planned.dates, days }) }
  }

  async preview(tenantId: string, hotelIdRaw: string, poolIdRaw: string, body: PoolCapacityEditRequest): Promise<PoolCapacityPreview> {
    const { value, errors } = normaliseCapacityEdit(body)
    if (!value) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const { pool, today, planned, fingerprint } = await this.plan(tx, tenantId, hotel, poolIdRaw, value)
      const archived = pool.status !== 'ACTIVE'
      const errorsOut = [...planned.errors, ...(archived ? ['The pool is archived and cannot be edited'] : [])]
      const shown = planned.rows.slice(0, POOL_CAPACITY_LIMITS.reportedRows)
      return {
        generatedAt: this.clock().toISOString(), poolId: pool.id, poolName: pool.name, timeZone: hotel.timeZone, hotelToday: today, fingerprint,
        counts: planned.counts, rows: shown.map(({ id: _id, ...row }) => row), truncated: planned.rows.length > shown.length, errors: errorsOut,
        canApply: errorsOut.length === 0 && planned.counts.invalid === 0 && planned.counts.willChange > 0,
        notes: [
          'Editing capacity changes the number of rooms the pool offers on these nights. It does not allocate stock, create or release holds, change prices or restrictions, or enable booking.',
          'Only nights that already have a pool stock row can be edited. A night with no row is unknown, not zero, and adding one is supply authoring.',
        ],
      }
    })
  }

  async apply(tenantId: string, userId: string, hotelIdRaw: string, poolIdRaw: string, body: PoolCapacityApply, requestId: string | null): Promise<PoolCapacityApplied> {
    if (typeof body?.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) throw new BadRequestException('idempotencyKey is required (8-80 letters, digits or . _ : -)')
    if (typeof body.expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedFingerprint)) throw new BadRequestException('expectedFingerprint is required: preview the change first')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < POOL_CAPACITY_LIMITS.reasonMin || reason.length > POOL_CAPACITY_LIMITS.reasonMax || /[\u0000-\u001f\u007f]/.test(reason)) throw new BadRequestException(`A reason of ${POOL_CAPACITY_LIMITS.reasonMin} to ${POOL_CAPACITY_LIMITS.reasonMax} printable characters is required`)
    const { value, errors } = normaliseCapacityEdit(body)
    if (!value) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    const requestHash = hash({ poolId: poolIdRaw, value })
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      // One writer at a time per hotel: the same locks Quick Update and pool administration take, in a fixed order.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quick-update:${tenantId}:${hotel.id}`}))`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory:${tenantId}:${hotel.id}`}))`
      const prior = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'hotel', entityId: hotel.id, action: POOL_CAPACITY_ACTION, payload: { path: ['idempotencyKey'], equals: body.idempotencyKey } }, select: { payload: true } })
      if (prior) {
        const p = prior.payload as { requestHash?: string; requestId?: string; changed?: PoolCapacityApplied['changed']; fingerprintAfter?: string }
        if (p.requestHash !== requestHash) throw new ConflictException({ message: 'This idempotency key was already used for a different request.', code: 'IDEMPOTENCY_KEY_REUSED' })
        return { replayed: true, auditRequestId: p.requestId ?? '', changed: p.changed ?? { updated: 0 }, fingerprintAfter: p.fingerprintAfter ?? '' }
      }
      const { pool, days, planned, fingerprint } = await this.plan(tx, tenantId, hotel, poolIdRaw, value)
      if (pool.status !== 'ACTIVE') throw new ConflictException({ message: 'The pool is archived and cannot be edited.', code: 'POOL_ARCHIVED' })
      if (planned.errors.length) throw new UnprocessableEntityException({ message: planned.errors, code: 'POOL_CAPACITY_INVALID' })
      if (planned.counts.invalid > 0) {
        const first = planned.rows.filter((r) => r.outcome === 'INVALID').slice(0, 5).map((r) => `${r.date}: ${r.problems[0]}`)
        throw new UnprocessableEntityException({ message: [`${planned.counts.invalid} night(s) are invalid, so nothing was written.`, ...first], code: 'POOL_CAPACITY_INVALID' })
      }
      if (fingerprint !== body.expectedFingerprint) throw new ConflictException({ message: 'The pool nights, their consumption or this request changed after you previewed it. Nothing was written. Preview again to see the current values.', code: 'POOL_CAPACITY_STALE' })
      if (planned.counts.willChange === 0) throw new ConflictException({ message: 'Nothing would change: every selected night already has this capacity.', code: 'POOL_CAPACITY_NO_CHANGE' })

      let updated = 0
      for (const row of planned.rows) {
        if (row.outcome !== 'CHANGE') continue
        // Capacity and timestamp only; supplier provenance and freshness remain unchanged (ADR 0037).
        // The guard keeps capacity at or above sold + held at the instant of the write, whatever a concurrent hold did since the preview.
        const changed = await tx.$executeRaw(Prisma.sql`
          UPDATE "InventoryPoolDay"
             SET "capacity" = ${value.capacity}, "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" = ${row.id} AND "tenant_id" = ${tenantId} AND "pool_id" = ${pool.id} AND "sold" + "held" <= ${value.capacity}
             AND "capacity" = ${row.before!.capacity} AND "sold" = ${row.before!.sold} AND "held" = ${row.before!.held}
             AND "updated_at" = ${days.get(row.date)!.updatedAt}
        `)
        if (changed !== 1) throw new ConflictException({ message: 'Pool stock changed while saving. Nothing was written. Preview again to see the current values.', code: 'POOL_CAPACITY_STALE' })
        updated += 1
      }
      const after = await this.loadDays(tx, tenantId, pool.id, planned.dates)
      const fingerprintAfter = capacityFingerprint({ poolId: pool.id, status: pool.status, value, dates: planned.dates, days: after })
      const sample = planned.rows.filter((r) => r.outcome === 'CHANGE').slice(0, 20).map((r) => ({ date: r.date, from: r.before ? r.before.capacity : null, to: value.capacity }))
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: POOL_CAPACITY_ACTION, entityType: 'hotel', entityId: hotel.id, payload: {
        outcome: 'allowed', requestId, idempotencyKey: body.idempotencyKey, requestHash, reason, poolId: pool.id, poolName: pool.name,
        startDate: value.startDate, endDate: value.endDate, weekdays: value.weekdays, capacity: value.capacity,
        changed: { updated }, fingerprintBefore: fingerprint, fingerprintAfter, sample,
      } as unknown as Prisma.InputJsonValue } })
      return { replayed: false, auditRequestId: requestId ?? '', changed: { updated }, fingerprintAfter }
    })
  }
}
