import { createHash } from 'crypto'
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  INVENTORY_LIMITS, INVENTORY_MODES,
  type HotelInventorySummary, type InventoryMode, type InventoryPlanSummary, type InventoryPool, type InventoryPoolCreateRequest, type InventoryPoolMembersRequest,
  type InventoryPoolResult, type InventoryPoolUpdateRequest, type InventoryReleaseRequest, type InventoryReleaseResult,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { idParam } from '../admin-operations/query-params'
import { dayInZone } from '../hotel-setup/quick-update-rules'
import { rowIsFresh } from '../supply/contracted-sellability'
import { isValidReleaseTime } from '../supply/zoned-time'

type Tx = Prisma.TransactionClient
const KEY = /^[A-Za-z0-9_.:-]{8,80}$/
const MS = 86_400_000
const SUMMARY_DEFAULT_DAYS = 30
const SUMMARY_MAX_DAYS = 90
const day = (d: Date) => d.toISOString().slice(0, 10)
const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`)
const addDays = (d: string, n: number) => day(new Date(toDate(d).getTime() + n * MS))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const POOL_ACTIONS = { created: 'inventory.pool.created', member: 'inventory.pool.member_added', memberRemoved: 'inventory.pool.member_removed', updated: 'inventory.pool.updated', release: 'inventory.release.changed' } as const

/**
 * Admin side of Inventory & Allotment (ADR 0030): the hotel inventory summary, shared pool management and the release rule.
 * Tenant comes from the session; every plan, supplier and pool is verified against the hotel. Every change is idempotent
 * (same key and same body replays, same key and a different body is refused), uses compare-and-set on `updatedAt` so a stale
 * form is rejected rather than overwritten, takes a per-hotel advisory lock, and writes an immutable audit event in the same
 * transaction. Stock edits themselves go through Quick Update; nothing here moves counters.
 */
@Injectable()
export class InventoryAdminService {
  /** Replaceable in tests. */
  clock: () => Date = () => new Date()
  constructor(private readonly prisma: PrismaService) {}

  private async hotel(tx: Tx, tenantId: string, hotelIdRaw: string) {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId }, select: { id: true, timeZone: true } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    return hotel
  }

  private lock(tx: Tx, tenantId: string, hotelId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inventory:${tenantId}:${hotelId}`}))`
  }

  private requireKey(key: unknown): string {
    if (typeof key !== 'string' || !KEY.test(key)) throw new BadRequestException('idempotencyKey is required (8-80 letters, digits or . _ : -)')
    return key
  }

  private requireText(value: unknown, field: string, min: number, max: number): string {
    const text = typeof value === 'string' ? value.trim() : ''
    // eslint-disable-next-line no-control-regex
    if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new BadRequestException(`${field} must be ${min}-${max} printable characters`)
    return text
  }

  private async prior(tx: Tx, tenantId: string, hotelId: string, action: string, key: string, requestHash: string): Promise<Record<string, unknown> | null> {
    const found = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'hotel', entityId: hotelId, action, payload: { path: ['idempotencyKey'], equals: key } }, select: { payload: true } })
    if (!found) return null
    const payload = found.payload as Record<string, unknown>
    if (payload.requestHash !== requestHash) throw new ConflictException({ message: 'This idempotency key was already used for a different request.', code: 'IDEMPOTENCY_KEY_REUSED' })
    return payload
  }

  private audit(tx: Tx, tenantId: string, userId: string, action: string, hotelId: string, payload: Record<string, unknown>) {
    return tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action, entityType: 'hotel', entityId: hotelId, payload: { outcome: 'allowed', ...payload } as Prisma.InputJsonValue } })
  }

  // ---- summary ------------------------------------------------------------------------------------------------------------
  async summary(tenantId: string, hotelIdRaw: string, query: { from?: unknown; days?: unknown }): Promise<HotelInventorySummary> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      const now = this.clock()
      const today = dayInZone(now, hotel.timeZone)
      const from = typeof query.from === 'string' && query.from !== '' ? query.from : today
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || day(toDate(from)) !== from) throw new BadRequestException('Invalid from')
      const days = query.days === undefined || query.days === '' ? SUMMARY_DEFAULT_DAYS : Number(query.days)
      if (!Number.isInteger(days) || days < 1 || days > SUMMARY_MAX_DAYS) throw new BadRequestException(`Invalid days (1-${SUMMARY_MAX_DAYS})`)
      const dates = Array.from({ length: days }, (_, i) => addDays(from, i))
      const gte = toDate(dates[0]); const lte = toDate(dates[dates.length - 1])

      const plans = await tx.ratePlan.findMany({
        where: { tenantId, roomType: { hotelId: hotel.id } },
        select: {
          id: true, code: true, status: true, releaseDays: true, releaseTimeLocal: true, inventoryPoolId: true, updatedAt: true,
          roomType: { select: { name: true } }, boardBasis: { select: { code: true } },
          contract: { select: { code: true, supplierId: true, supplier: { select: { displayName: true } } } },
          availability: { where: { tenantId, stayDate: { gte, lte } }, select: { inventoryMode: true, source: true, freshUntil: true } },
        },
        orderBy: [{ roomType: { name: 'asc' } }, { code: 'asc' }, { id: 'asc' }],
      })
      const pools = await tx.inventoryPool.findMany({
        where: { tenantId, hotelId: hotel.id },
        select: { id: true, name: true, status: true, supplierId: true, updatedAt: true, supplier: { select: { displayName: true } }, days: { where: { tenantId, stayDate: { gte, lte } }, select: { stayDate: true, capacity: true, sold: true, held: true, source: true, freshUntil: true } } },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      })
      const poolName = new Map(pools.map((p) => [p.id, p.name]))
      const planSummaries: InventoryPlanSummary[] = plans.map((plan) => {
        const modeCounts = Object.fromEntries(INVENTORY_MODES.map((m) => [m, 0])) as Record<InventoryMode, number>
        let stale = 0
        for (const row of plan.availability) {
          modeCounts[(INVENTORY_MODES as readonly string[]).includes(row.inventoryMode) ? row.inventoryMode as InventoryMode : 'CLOSED'] += 1
          if (!rowIsFresh(row.source, row.freshUntil ? row.freshUntil.toISOString() : null, now)) stale += 1
        }
        return {
          ratePlanId: plan.id, ratePlanCode: plan.code, roomName: plan.roomType.name, boardCode: plan.boardBasis.code.trim(), contractCode: plan.contract.code, supplierId: plan.contract.supplierId, supplierName: plan.contract.supplier.displayName, planStatus: plan.status,
          poolId: plan.inventoryPoolId, poolName: plan.inventoryPoolId ? poolName.get(plan.inventoryPoolId) ?? null : null,
          releaseDays: plan.releaseDays, releaseTimeLocal: plan.releaseTimeLocal, updatedAt: plan.updatedAt.toISOString(), modeCounts,
          nightsWithRow: plan.availability.length, nightsMissing: days - plan.availability.length, nightsStale: stale,
        }
      })
      const poolSummaries: InventoryPool[] = pools.map((pool) => {
        const byDate = new Map(pool.days.map((d) => [day(d.stayDate), d]))
        const nights = dates.map((date) => {
          const d = byDate.get(date)
          if (!d) return { date, capacity: null, sold: null, held: null, remaining: null, stale: false }
          return { date, capacity: d.capacity, sold: d.sold, held: d.held, remaining: d.capacity - d.sold - d.held, stale: !rowIsFresh(d.source, d.freshUntil ? d.freshUntil.toISOString() : null, now) }
        })
        const members = plans.filter((p) => p.inventoryPoolId === pool.id).map((p) => ({ ratePlanId: p.id, ratePlanCode: p.code, roomName: p.roomType.name, boardCode: p.boardBasis.code.trim(), contractCode: p.contract.code, planStatus: p.status }))
        return { id: pool.id, name: pool.name, status: pool.status, supplierId: pool.supplierId, supplierName: pool.supplier.displayName, updatedAt: pool.updatedAt.toISOString(), members, nights, missingNights: nights.filter((n) => n.capacity === null).length }
      })
      return {
        hotelId: hotel.id, timeZone: hotel.timeZone, generatedAt: now.toISOString(), window: { from: dates[0], to: dates[dates.length - 1], days },
        plans: planSummaries, pools: poolSummaries,
        totals: { plans: planSummaries.length, pooledPlans: planSummaries.filter((p) => p.poolId).length, pools: poolSummaries.filter((p) => p.status === 'ACTIVE').length, nightsMissing: planSummaries.reduce((a, p) => a + p.nightsMissing, 0), nightsStale: planSummaries.reduce((a, p) => a + p.nightsStale, 0) },
      }
    })
  }

  private async poolView(tenantId: string, hotelId: string, poolId: string): Promise<InventoryPool | null> {
    const s = await this.summary(tenantId, hotelId, {})
    return s.pools.find((p) => p.id === poolId) ?? null
  }

  // ---- shared validation ----------------------------------------------------------------------------------------------------
  private async eligiblePlans(tx: Tx, tenantId: string, hotel: { id: string; timeZone: string }, supplierId: string, ids: string[], today: string) {
    if (new Set(ids).size !== ids.length) throw new UnprocessableEntityException({ message: 'A rate plan is listed more than once.', code: 'POOL_DUPLICATE_MEMBER' })
    if (ids.length > INVENTORY_LIMITS.poolMembers) throw new BadRequestException(`At most ${INVENTORY_LIMITS.poolMembers} rate plans per pool`)
    for (const id of ids) if (!idParam('ratePlanId', id)) throw new BadRequestException('Invalid ratePlanId')
    if (ids.length === 0) return
    const plans = await tx.ratePlan.findMany({ where: { id: { in: ids }, tenantId, roomType: { hotelId: hotel.id } }, select: { id: true, status: true, inventoryPoolId: true, contract: { select: { supplierId: true } } } })
    if (plans.length !== ids.length) throw new UnprocessableEntityException({ message: 'A rate plan does not belong to this hotel.', code: 'POOL_MEMBER_NOT_FOUND' })
    for (const plan of plans) {
      if (plan.contract.supplierId !== supplierId) throw new UnprocessableEntityException({ message: 'A pool only holds rate plans of its own supplier.', code: 'POOL_SUPPLIER_MISMATCH' })
      if (plan.status === 'EXPIRED') throw new UnprocessableEntityException({ message: 'An expired rate plan cannot join a pool.', code: 'POOL_MEMBER_EXPIRED' })
      if (plan.inventoryPoolId) throw new ConflictException({ message: 'A rate plan is already in a pool. Remove it from that pool first; plans are never moved silently.', code: 'POOL_MEMBER_IN_OTHER_POOL' })
    }
    // Pooling a plan that already sold or held units on its own row would double count them: refuse until those nights are clear.
    const committed = await tx.dailyAvailability.count({ where: { tenantId, ratePlanId: { in: ids }, stayDate: { gte: toDate(today) }, OR: [{ sold: { gt: 0 } }, { held: { gt: 0 } }] } })
    if (committed > 0) throw new ConflictException({ message: `${committed} future night(s) already have units sold or held on the plan itself. Pooling now would double count them.`, code: 'POOL_MEMBER_HAS_COMMITMENTS' })
  }

  private translate(error: unknown): never {
    if (error instanceof HttpException) throw error // already a deliberate, user-facing refusal
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ message: 'A pool with this name already exists for this supplier.', code: 'POOL_NAME_TAKEN' })
    const message = error instanceof Error ? error.message : ''
    if (/inventory pool|rate plan.*pool|pool_consistency/i.test(message)) throw new UnprocessableEntityException({ message: 'The pool and the rate plans must belong to the same hotel and supplier, and the pool must be active.', code: 'POOL_CONSISTENCY' })
    throw error
  }

  // ---- pool create / members / update ---------------------------------------------------------------------------------------
  async createPool(tenantId: string, userId: string, hotelIdRaw: string, body: InventoryPoolCreateRequest, requestId: string | null): Promise<InventoryPoolResult> {
    const key = this.requireKey(body?.idempotencyKey)
    const name = this.requireText(body?.name, 'name', 1, INVENTORY_LIMITS.poolNameMax)
    const supplierId = idParam('supplierId', body?.supplierId)
    if (!supplierId) throw new BadRequestException('supplierId is required')
    const ratePlanIds = Array.isArray(body.ratePlanIds) ? body.ratePlanIds : []
    const requestHash = hash({ name, supplierId, ratePlanIds: [...ratePlanIds].sort() })
    try {
      const result = await this.prisma.withTenant(tenantId, async (tx) => {
        const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
        await this.lock(tx, tenantId, hotel.id)
        const prior = await this.prior(tx, tenantId, hotel.id, POOL_ACTIONS.created, key, requestHash)
        if (prior) return { replayed: true, poolId: String(prior.poolId) }
        const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId, mappings: { some: { tenantId, hotelId: hotel.id } } }, select: { id: true } })
        if (!supplier) throw new UnprocessableEntityException({ message: 'The supplier is not mapped to this hotel.', code: 'POOL_SUPPLIER_NOT_MAPPED' })
        await this.eligiblePlans(tx, tenantId, hotel, supplierId, ratePlanIds, dayInZone(this.clock(), hotel.timeZone))
        const pool = await tx.inventoryPool.create({ data: { tenantId, hotelId: hotel.id, supplierId, name, createdById: userId } })
        if (ratePlanIds.length) await tx.ratePlan.updateMany({ where: { id: { in: ratePlanIds }, tenantId, inventoryPoolId: null }, data: { inventoryPoolId: pool.id } })
        await this.audit(tx, tenantId, userId, POOL_ACTIONS.created, hotel.id, { requestId, idempotencyKey: key, requestHash, poolId: pool.id, name, supplierId, memberCount: ratePlanIds.length })
        for (const ratePlanId of ratePlanIds) await this.audit(tx, tenantId, userId, POOL_ACTIONS.member, hotel.id, { requestId, poolId: pool.id, ratePlanId })
        return { replayed: false, poolId: pool.id }
      })
      return { replayed: result.replayed, pool: await this.poolView(tenantId, hotelIdRaw, result.poolId) }
    } catch (error) { return this.translate(error) }
  }

  private async mutateMembers(tenantId: string, userId: string, hotelIdRaw: string, poolId: string, body: InventoryPoolMembersRequest, requestId: string | null, add: boolean): Promise<InventoryPoolResult> {
    const key = this.requireKey(body?.idempotencyKey)
    const id = idParam('poolId', poolId)
    if (!id) throw new BadRequestException('Invalid poolId')
    const ids = Array.isArray(body?.ratePlanIds) ? body.ratePlanIds : []
    if (ids.length < 1) throw new BadRequestException('Choose at least one rate plan')
    const expected = this.expected(body?.expectedUpdatedAt)
    const action = add ? POOL_ACTIONS.member : POOL_ACTIONS.memberRemoved
    const requestHash = hash({ add, poolId: id, ratePlanIds: [...ids].sort() })
    try {
      const result = await this.prisma.withTenant(tenantId, async (tx) => {
        const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
        await this.lock(tx, tenantId, hotel.id)
        const prior = await this.prior(tx, tenantId, hotel.id, action, key, requestHash)
        if (prior) return { replayed: true }
        const pool = await tx.inventoryPool.findFirst({ where: { id, tenantId, hotelId: hotel.id }, select: { id: true, status: true, supplierId: true } })
        if (!pool) throw new NotFoundException('Pool not found')
        if (pool.status !== 'ACTIVE') throw new ConflictException({ message: 'The pool is archived.', code: 'POOL_ARCHIVED' })
        await this.touch(tx, tenantId, pool.id, expected)
        if (add) await this.eligiblePlans(tx, tenantId, hotel, pool.supplierId, ids, dayInZone(this.clock(), hotel.timeZone))
        else {
          const members = await tx.ratePlan.count({ where: { id: { in: ids }, tenantId, inventoryPoolId: pool.id } })
          if (members !== new Set(ids).size) throw new UnprocessableEntityException({ message: 'A rate plan is not a member of this pool.', code: 'POOL_MEMBER_NOT_FOUND' })
        }
        const changed = await tx.ratePlan.updateMany({ where: add ? { id: { in: ids }, tenantId, inventoryPoolId: null } : { id: { in: ids }, tenantId, inventoryPoolId: pool.id }, data: { inventoryPoolId: add ? pool.id : null } })
        if (changed.count !== new Set(ids).size) throw new ConflictException({ message: 'Membership changed while saving. Nothing was written.', code: 'POOL_STALE' })
        await this.audit(tx, tenantId, userId, action, hotel.id, { requestId, idempotencyKey: key, requestHash, poolId: pool.id, ratePlanIds: ids })
        return { replayed: false }
      })
      return { replayed: result.replayed, pool: await this.poolView(tenantId, hotelIdRaw, id) }
    } catch (error) { return this.translate(error) }
  }
  addMembers(tenantId: string, userId: string, hotelId: string, poolId: string, body: InventoryPoolMembersRequest, requestId: string | null) { return this.mutateMembers(tenantId, userId, hotelId, poolId, body, requestId, true) }
  removeMembers(tenantId: string, userId: string, hotelId: string, poolId: string, body: InventoryPoolMembersRequest, requestId: string | null) { return this.mutateMembers(tenantId, userId, hotelId, poolId, body, requestId, false) }

  private expected(value: unknown): Date {
    const parsed = typeof value === 'string' ? new Date(value) : null
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new BadRequestException('expectedUpdatedAt is required: reload the pool first')
    return parsed
  }

  /** Compare-and-set on updatedAt: succeeds only if nobody changed the pool since the caller read it, and advances the token. */
  private async touch(tx: Tx, tenantId: string, poolId: string, expected: Date): Promise<void> {
    const moved = await tx.inventoryPool.updateMany({ where: { id: poolId, tenantId, updatedAt: expected }, data: { updatedAt: new Date() } })
    if (moved.count !== 1) throw new ConflictException({ message: 'The pool changed after you loaded it. Nothing was written. Reload to see the current pool.', code: 'POOL_STALE' })
  }

  async updatePool(tenantId: string, userId: string, hotelIdRaw: string, poolId: string, body: InventoryPoolUpdateRequest, requestId: string | null): Promise<InventoryPoolResult> {
    const key = this.requireKey(body?.idempotencyKey)
    const id = idParam('poolId', poolId)
    if (!id) throw new BadRequestException('Invalid poolId')
    const expected = this.expected(body?.expectedUpdatedAt)
    const name = body.name === undefined ? undefined : this.requireText(body.name, 'name', 1, INVENTORY_LIMITS.poolNameMax)
    if (name === undefined && body.archive !== true) throw new BadRequestException('Nothing to change')
    const requestHash = hash({ poolId: id, name: name ?? null, archive: body.archive === true })
    try {
      const result = await this.prisma.withTenant(tenantId, async (tx) => {
        const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
        await this.lock(tx, tenantId, hotel.id)
        const prior = await this.prior(tx, tenantId, hotel.id, POOL_ACTIONS.updated, key, requestHash)
        if (prior) return { replayed: true }
        const pool = await tx.inventoryPool.findFirst({ where: { id, tenantId, hotelId: hotel.id }, select: { id: true, status: true } })
        if (!pool) throw new NotFoundException('Pool not found')
        if (pool.status !== 'ACTIVE') throw new ConflictException({ message: 'The pool is archived.', code: 'POOL_ARCHIVED' })
        await this.touch(tx, tenantId, pool.id, expected)
        if (body.archive === true) {
          if (await tx.ratePlan.count({ where: { tenantId, inventoryPoolId: pool.id } }) > 0) throw new ConflictException({ message: 'Remove every rate plan from the pool before archiving it.', code: 'POOL_HAS_MEMBERS' })
          const committed = await tx.inventoryPoolDay.count({ where: { tenantId, poolId: pool.id, stayDate: { gte: toDate(dayInZone(this.clock(), hotel.timeZone)) }, OR: [{ sold: { gt: 0 } }, { held: { gt: 0 } }] } })
          if (committed > 0) throw new ConflictException({ message: `${committed} future night(s) still have units sold or held on this pool.`, code: 'POOL_HAS_COMMITMENTS' })
        }
        await tx.inventoryPool.update({ where: { id: pool.id }, data: { ...(name !== undefined ? { name } : {}), ...(body.archive === true ? { status: 'ARCHIVED', archivedAt: this.clock() } : {}) } })
        await this.audit(tx, tenantId, userId, POOL_ACTIONS.updated, hotel.id, { requestId, idempotencyKey: key, requestHash, poolId: pool.id, renamed: name !== undefined, archived: body.archive === true })
        return { replayed: false }
      })
      return { replayed: result.replayed, pool: await this.poolView(tenantId, hotelIdRaw, id) }
    } catch (error) { return this.translate(error) }
  }

  // ---- release rule ----------------------------------------------------------------------------------------------------------
  async setRelease(tenantId: string, userId: string, hotelIdRaw: string, ratePlanIdRaw: string, body: InventoryReleaseRequest, requestId: string | null): Promise<InventoryReleaseResult> {
    const key = this.requireKey(body?.idempotencyKey)
    const ratePlanId = idParam('ratePlanId', ratePlanIdRaw)
    if (!ratePlanId) throw new BadRequestException('Invalid ratePlanId')
    const releaseDays = body?.releaseDays
    if (!Number.isInteger(releaseDays) || releaseDays < 0 || releaseDays > INVENTORY_LIMITS.releaseDaysMax) throw new BadRequestException(`releaseDays must be a whole number from 0 to ${INVENTORY_LIMITS.releaseDaysMax}`)
    if (typeof body.releaseTimeLocal !== 'string' || !isValidReleaseTime(body.releaseTimeLocal)) throw new BadRequestException('releaseTimeLocal must be a 24-hour HH:mm time')
    const reason = this.requireText(body.reason, 'reason', 3, 500)
    const expected = this.expected(body.expectedUpdatedAt)
    const requestHash = hash({ ratePlanId, releaseDays, releaseTimeLocal: body.releaseTimeLocal })
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotel(tx, tenantId, hotelIdRaw)
      await this.lock(tx, tenantId, hotel.id)
      const prior = await this.prior(tx, tenantId, hotel.id, POOL_ACTIONS.release, key, requestHash)
      const plan = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId, roomType: { hotelId: hotel.id } }, select: { id: true, status: true, releaseDays: true, releaseTimeLocal: true, updatedAt: true } })
      if (!plan) throw new NotFoundException('Rate plan not found')
      if (prior) return { replayed: true, ratePlanId, releaseDays: plan.releaseDays, releaseTimeLocal: plan.releaseTimeLocal, updatedAt: plan.updatedAt.toISOString() }
      if (plan.status === 'EXPIRED') throw new ConflictException({ message: 'An expired rate plan cannot be changed.', code: 'PLAN_EXPIRED' })
      const moved = await tx.ratePlan.updateMany({ where: { id: plan.id, tenantId, updatedAt: expected }, data: { releaseDays, releaseTimeLocal: body.releaseTimeLocal } })
      if (moved.count !== 1) throw new ConflictException({ message: 'The rate plan changed after you loaded it. Nothing was written. Reload to see the current values.', code: 'PLAN_STALE' })
      const updated = await tx.ratePlan.findUniqueOrThrow({ where: { id: plan.id }, select: { updatedAt: true } })
      await this.audit(tx, tenantId, userId, POOL_ACTIONS.release, hotel.id, {
        requestId, idempotencyKey: key, requestHash, reason, ratePlanId: plan.id,
        from: { releaseDays: plan.releaseDays, releaseTimeLocal: plan.releaseTimeLocal }, to: { releaseDays, releaseTimeLocal: body.releaseTimeLocal },
      })
      return { replayed: false, ratePlanId: plan.id, releaseDays, releaseTimeLocal: body.releaseTimeLocal, updatedAt: updated.updatedAt.toISOString() }
    })
  }
}
