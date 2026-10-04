import { createHash } from 'crypto'
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  QUICK_UPDATE_LIMITS, QUICK_UPDATE_UNSUPPORTED,
  type QuickUpdateApplied, type QuickUpdateApply, type QuickUpdatePlanRef, type QuickUpdatePreview, type QuickUpdateRequest,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { idParam } from '../admin-operations/query-params'
import { dayInZone, normaliseQuickUpdate, planQuickUpdate, type AvailState, type NormalisedQuickUpdate, type PlanInfo, type PlannedRow, type PoolDayState, type RateState } from './quick-update-rules'

type Tx = Prisma.TransactionClient
const KEY = /^[A-Za-z0-9_.:-]{8,80}$/
const APPLIED = 'hotel.quick_update.applied'
const day = (d: Date) => d.toISOString().slice(0, 10)
const toDate = (d: string) => new Date(`${d}T00:00:00.000Z`)

interface Loaded {
  hotel: { id: string; timeZone: string }
  plans: Map<string, PlanInfo>
  refs: Map<string, QuickUpdatePlanRef>
  rates: Map<string, RateState>
  avail: Map<string, AvailState>
  pools: Map<string, PoolDayState>
  /** Existing pool days keyed like `pools`, with their ids, for the write step. */
  poolDayIds: Map<string, string>
  fingerprint: string
}

/**
 * Quick Update (ADR 0021, stage 5): preview, then atomically apply, a change to rates, availability and per-night restrictions
 * for one hotel. Tenant comes from the session and every plan must belong to the hotel. Apply never trusts a preview: it takes a
 * per-hotel advisory lock, re-reads the current rows, re-runs the same validation and compares the fingerprint of what it read with
 * the one the operator reviewed. Money stays integer minor units; nothing is written unless every record is valid.
 */
@Injectable()
export class HotelQuickUpdateService {
  /** Replaceable in tests. */
  clock: () => Date = () => new Date()
  constructor(private readonly prisma: PrismaService) {}

  /** The manage permissions a request needs: price needs rates, availability and restrictions need availability. */
  required(value: NormalisedQuickUpdate): Array<'supply.rates.manage' | 'supply.availability.manage'> {
    const out: Array<'supply.rates.manage' | 'supply.availability.manage'> = []
    if (value.changes.price) out.push('supply.rates.manage')
    if (value.changes.availability || value.changes.restrictions) out.push('supply.availability.manage')
    return out
  }

  private async requirePermissions(tenantId: string, userId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const roles = await this.prisma.withTenant(tenantId, (tx) => tx.userRole.findMany({ where: { userId, tenantId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }))
    const held = new Set(roles.flatMap((a) => a.role.permissions.map((p) => p.permission.key)))
    const missing = keys.filter((k) => !held.has(k))
    if (missing.length) throw new ForbiddenException(`Insufficient permission: ${missing.join(', ')}`)
  }

  private async load(tx: Tx, tenantId: string, hotelIdRaw: string, value: NormalisedQuickUpdate): Promise<Loaded & { dates: string[] }> {
    const id = idParam('hotelId', hotelIdRaw)
    if (!id) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id, tenantId }, select: { id: true, timeZone: true } })
    if (!hotel) throw new NotFoundException('Hotel not found')
    const found = await tx.ratePlan.findMany({
      where: { id: { in: value.ratePlanIds }, tenantId, roomType: { hotelId: hotel.id } },
      include: { roomType: { select: { name: true } }, boardBasis: { select: { code: true } }, contract: { select: { code: true, validFrom: true, validTo: true, supplier: { select: { displayName: true } } } } },
    })
    const plans = new Map<string, PlanInfo>(); const refs = new Map<string, QuickUpdatePlanRef>()
    for (const p of found) {
      plans.set(p.id, { id: p.id, status: p.status, currency: p.currency, occupancy: p.occupancy, contractFrom: day(p.contract.validFrom), contractTo: day(p.contract.validTo), poolId: p.inventoryPoolId })
      refs.set(p.id, { id: p.id, code: p.code, roomName: p.roomType.name, boardCode: p.boardBasis.code.trim(), contractCode: p.contract.code, supplierName: p.contract.supplier.displayName, currency: p.currency, occupancy: p.occupancy, status: p.status })
    }
    const dates = [...new Set(value.ranges.flatMap((r) => [r.from, r.to]))].sort()
    const gte = toDate(dates[0]); const lte = toDate(dates[dates.length - 1])
    const planIds = [...plans.keys()]
    const [rateRows, availRows] = planIds.length === 0 ? [[], []] : await Promise.all([
      tx.dailyRate.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte, lte } } }),
      tx.dailyAvailability.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte, lte } } }),
    ])
    const poolIds = [...new Set([...plans.values()].map((p) => p.poolId).filter((id): id is string => !!id))]
    const poolRows = poolIds.length === 0 ? [] : await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: { in: poolIds }, stayDate: { gte, lte } } })
    const rates = new Map<string, RateState>(); const avail = new Map<string, AvailState>(); const lines: string[] = []
    const pools = new Map<string, PoolDayState>(); const poolDayIds = new Map<string, string>()
    for (const p of found) lines.push(`P|${p.id}|${p.status}|${p.currency}|${p.occupancy}|${day(p.contract.validFrom)}|${day(p.contract.validTo)}|${p.inventoryPoolId ?? ''}`)
    for (const d of poolRows) {
      pools.set(`${d.poolId}:${day(d.stayDate)}`, { capacity: d.capacity, sold: d.sold, held: d.held }); poolDayIds.set(`${d.poolId}:${day(d.stayDate)}`, d.id)
      lines.push(`D|${d.poolId}|${day(d.stayDate)}|${d.capacity}|${d.sold}|${d.held}|${d.updatedAt.getTime()}`)
    }
    for (const r of rateRows) {
      if (r.occupancy !== plans.get(r.ratePlanId)!.occupancy) continue
      rates.set(`${r.ratePlanId}:${day(r.stayDate)}`, { amountMinor: r.amountMinor, basis: r.amountBasis === 'NET' || r.amountBasis === 'SELL' ? r.amountBasis : null })
      lines.push(`R|${r.ratePlanId}|${day(r.stayDate)}|${r.amountMinor}|${r.amountBasis ?? ''}|${r.updatedAt.getTime()}`)
    }
    for (const a of availRows) {
      avail.set(`${a.ratePlanId}:${day(a.stayDate)}`, { allotment: a.allotment, sold: a.sold, held: a.held, stopSell: a.stopSell, minStay: a.minStay, closedToArrival: a.closedToArrival, closedToDeparture: a.closedToDeparture, mode: a.inventoryMode })
      lines.push(`A|${a.ratePlanId}|${day(a.stayDate)}|${a.allotment}|${a.sold}|${a.held}|${a.stopSell}|${a.minStay}|${a.closedToArrival}|${a.closedToDeparture}|${a.inventoryMode}|${a.updatedAt.getTime()}`)
    }
    const fingerprint = createHash('sha256').update(lines.sort().join('\n')).digest('hex')
    return { hotel, plans, refs, rates, avail, pools, poolDayIds, fingerprint, dates: [] }
  }

  private plan(loaded: Loaded, value: NormalisedQuickUpdate) {
    return planQuickUpdate({ value, plans: loaded.plans, rates: loaded.rates, avail: loaded.avail, pools: loaded.pools, today: dayInZone(this.clock(), loaded.hotel.timeZone) })
  }

  async preview(tenantId: string, userId: string, hotelId: string, body: QuickUpdateRequest): Promise<QuickUpdatePreview> {
    const { value, errors } = normaliseQuickUpdate(body)
    if (!value) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    await this.requirePermissions(tenantId, userId, this.required(value))
    return this.prisma.withTenant(tenantId, async (tx) => {
      const loaded = await this.load(tx, tenantId, hotelId, value)
      const planned = this.plan(loaded, value)
      const shown = planned.rows.slice(0, QUICK_UPDATE_LIMITS.reportedRows)
      return {
        generatedAt: this.clock().toISOString(), fingerprint: loaded.fingerprint, hotelToday: dayInZone(this.clock(), loaded.hotel.timeZone), timeZone: loaded.hotel.timeZone,
        plans: value.ratePlanIds.map((id) => loaded.refs.get(id)).filter((p): p is QuickUpdatePlanRef => !!p), dates: planned.dates,
        counts: planned.counts,
        rows: shown.map(({ nextRate: _r, nextAvail: _a, ...row }) => row), truncated: planned.rows.length > shown.length,
        errors: planned.errors, unsupported: [...QUICK_UPDATE_UNSUPPORTED],
        canApply: planned.errors.length === 0 && planned.counts.invalid === 0 && planned.counts.willChange > 0,
      }
    })
  }

  async apply(tenantId: string, userId: string, hotelIdRaw: string, body: QuickUpdateApply, requestId: string | null): Promise<QuickUpdateApplied> {
    if (typeof body?.idempotencyKey !== 'string' || !KEY.test(body.idempotencyKey)) throw new BadRequestException('idempotencyKey is required (8-80 letters, digits or . _ : -)')
    if (typeof body.expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedFingerprint)) throw new BadRequestException('expectedFingerprint is required: preview the change first')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 3 || reason.length > 500) throw new BadRequestException('A reason of 3 to 500 characters is required')
    const { value, errors } = normaliseQuickUpdate(body)
    if (!value) throw new BadRequestException({ message: errors, error: 'Bad Request' })
    await this.requirePermissions(tenantId, userId, this.required(value))
    const hotelId = idParam('hotelId', hotelIdRaw)
    if (!hotelId) throw new BadRequestException('Invalid hotelId')
    return this.prisma.withTenant(tenantId, async (tx) => {
      // One apply per hotel at a time: the check and the write below must not interleave with another apply.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quick-update:${tenantId}:${hotelId}`}))`
      const prior = await tx.auditEvent.findFirst({ where: { tenantId, entityType: 'hotel', entityId: hotelId, action: APPLIED, payload: { path: ['idempotencyKey'], equals: body.idempotencyKey } }, select: { payload: true } })
      if (prior) {
        const p = prior.payload as { requestId?: string; records?: number; changed?: QuickUpdateApplied['changed']; fingerprintAfter?: string }
        return { replayed: true, auditRequestId: p.requestId ?? '', records: p.records ?? 0, changed: p.changed ?? { rates: 0, availabilityRows: 0, poolDays: 0 }, fingerprintAfter: p.fingerprintAfter ?? '' }
      }
      const loaded = await this.load(tx, tenantId, hotelId, value)
      const planned = this.plan(loaded, value)
      if (planned.errors.length) throw new UnprocessableEntityException({ message: planned.errors, code: 'QUICK_UPDATE_INVALID' })
      if (planned.counts.invalid > 0) {
        const first = planned.rows.filter((r) => r.outcome === 'INVALID').slice(0, 5).map((r) => `${r.date}: ${r.problems[0]}`)
        throw new UnprocessableEntityException({ message: [`${planned.counts.invalid} record(s) are invalid, so nothing was written.`, ...first], code: 'QUICK_UPDATE_INVALID' })
      }
      if (loaded.fingerprint !== body.expectedFingerprint) throw new ConflictException({ message: 'The rates or inventory changed after you previewed this update. Nothing was written. Preview again to see the current values.', code: 'QUICK_UPDATE_STALE' })
      if (planned.counts.willChange === 0) throw new ConflictException({ message: 'Nothing would change: every selected record already has these values.', code: 'QUICK_UPDATE_NO_CHANGE' })

      const writes = await this.write(tx, tenantId, loaded, planned.rows.filter((r) => r.outcome === 'CHANGE'))
      const after = await this.load(tx, tenantId, hotelId, value)
      const fields = [...new Set(planned.rows.flatMap((r) => r.changes.map((c) => c.field)))].sort()
      const sample = planned.rows.filter((r) => r.outcome === 'CHANGE').slice(0, 20).map((r) => ({ ratePlanId: r.ratePlanId, date: r.date, changes: r.changes }))
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: APPLIED, entityType: 'hotel', entityId: hotelId, payload: {
        outcome: 'allowed', requestId, idempotencyKey: body.idempotencyKey, reason, ratePlanIds: value.ratePlanIds, ranges: value.ranges, weekdays: value.weekdays, fields,
        records: planned.counts.records, changedRecords: planned.counts.willChange, changed: writes, fingerprintBefore: loaded.fingerprint, fingerprintAfter: after.fingerprint, sample,
      } as unknown as Prisma.InputJsonValue } })
      // Inventory-specific audit actions (ADR 0030), in the same transaction as the write.
      const inventoryFields = new Set(fields.filter((f) => f !== 'price'))
      if (inventoryFields.size > 0) {
        const detail = { requestId, idempotencyKey: body.idempotencyKey, reason, ratePlanIds: value.ratePlanIds, ranges: value.ranges, fields: [...inventoryFields], changedRecords: planned.counts.willChange, poolDays: writes.poolDays }
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: planned.counts.willChange > 1 ? 'inventory.bulk.updated' : 'inventory.daily.updated', entityType: 'hotel', entityId: hotelId, payload: { outcome: 'allowed', ...detail } as unknown as Prisma.InputJsonValue } })
        if (inventoryFields.has('inventoryMode')) await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'inventory.mode.changed', entityType: 'hotel', entityId: hotelId, payload: { outcome: 'allowed', requestId, ratePlanIds: value.ratePlanIds, to: value.changes.availability?.mode, changedRecords: planned.rows.filter((r) => r.changes.some((c) => c.field === 'inventoryMode')).length } as unknown as Prisma.InputJsonValue } })
      }
      return { replayed: false, auditRequestId: requestId ?? '', records: planned.counts.records, changed: writes, fingerprintAfter: after.fingerprint }
    })
  }

  private async write(tx: Tx, tenantId: string, loaded: Loaded, rows: PlannedRow[]): Promise<{ rates: number; availabilityRows: number; poolDays: number }> {
    let rates = 0; let availabilityRows = 0
    const now = this.clock()
    // Admin edits are fresh, first-hand data: provenance is stamped on every row this update writes.
    const provenance = { source: 'ADMIN' as const, sourceUpdatedAt: now, receivedAt: now, freshUntil: null }
    const newRates: Prisma.DailyRateCreateManyInput[] = []; const newAvail: Prisma.DailyAvailabilityCreateManyInput[] = []
    const poolWrites = new Map<string, NonNullable<PlannedRow['nextPool']> & { date: string }>()
    for (const row of rows) {
      const plan = loaded.plans.get(row.ratePlanId)!
      const stayDate = toDate(row.date)
      if (row.nextRate) {
        if (loaded.rates.has(`${row.ratePlanId}:${row.date}`)) await tx.dailyRate.update({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: row.ratePlanId, stayDate, occupancy: plan.occupancy } }, data: { amountMinor: row.nextRate.amountMinor, amountBasis: row.nextRate.basis, currency: plan.currency } })
        else newRates.push({ tenantId, ratePlanId: row.ratePlanId, stayDate, occupancy: plan.occupancy, amountMinor: row.nextRate.amountMinor, amountBasis: row.nextRate.basis, currency: plan.currency })
        rates++
      }
      if (row.nextAvail) {
        const n = row.nextAvail
        const fields = { allotment: n.allotment, stopSell: n.stopSell, minStay: n.minStay, closedToArrival: n.closedToArrival, closedToDeparture: n.closedToDeparture, inventoryMode: n.mode as Prisma.DailyAvailabilityCreateManyInput['inventoryMode'], ...provenance }
        if (n.create) newAvail.push({ tenantId, ratePlanId: row.ratePlanId, stayDate, sold: 0, held: 0, ...fields })
        else await this.guarded(() => tx.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: row.ratePlanId, stayDate } }, data: fields }))
        availabilityRows++
      }
      if (row.nextPool) poolWrites.set(`${row.nextPool.poolId}:${row.date}`, { ...row.nextPool, date: row.date })
    }
    if (newRates.length) await tx.dailyRate.createMany({ data: newRates })
    if (newAvail.length) await tx.dailyAvailability.createMany({ data: newAvail })
    // A pool night is written once however many pooled plans selected it. The guard keeps capacity at or above sold + held even
    // if a hold landed after the rows were read; if it did, nothing is written.
    for (const [key, w] of [...poolWrites.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (w.create) {
        await tx.inventoryPoolDay.create({ data: { tenantId, poolId: w.poolId, stayDate: toDate(w.date), capacity: w.capacity, ...provenance } })
      } else {
        const updated = await tx.$executeRaw`
          UPDATE "InventoryPoolDay" SET "capacity" = ${w.capacity}, "source" = 'ADMIN'::"InventorySource", "source_updated_at" = ${now}, "received_at" = ${now}, "fresh_until" = NULL, "updated_at" = CURRENT_TIMESTAMP
           WHERE "id" = ${loaded.poolDayIds.get(key)} AND "tenant_id" = ${tenantId} AND "sold" + "held" <= ${w.capacity}`
        if (updated !== 1) throw new ConflictException({ message: 'Pool stock changed while saving. Nothing was written. Preview again to see the current values.', code: 'QUICK_UPDATE_STALE' })
      }
    }
    return { rates, availabilityRows, poolDays: poolWrites.size }
  }

  /** A database CHECK that fires here means inventory moved between the read and the write: report it as stale, not as a server error. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error) {
      if (/check constraint/i.test(error instanceof Error ? error.message : '')) throw new ConflictException({ message: 'Inventory changed while saving. Nothing was written. Preview again to see the current values.', code: 'QUICK_UPDATE_STALE' })
      throw error
    }
  }
}
