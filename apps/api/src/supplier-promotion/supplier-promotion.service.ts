import { Injectable, Logger } from '@nestjs/common'
import type { InventoryMode, Prisma, SupplierPromotionStatus } from '@prisma/client'
import { enabledSettlementCurrencies } from '../agent/currency'
import { dayInZone } from '../hotel-setup/quick-update-rules'
import { evaluateBatchGuard, checkRatePromotable } from '../mapping/promotion-rules'
import { resolveAllotment, resolveRate } from '../mapping/observation-resolution'
import { mayFeedWriteNight, omittedNightsToClose, planStockCount, routeRoomWideStock, type NightState } from '../mapping/stock-promotion-rules'
import { IngestProfileRegistry } from '../supplier-ingest/ingest-profile'
import { loadMappingIndex } from '../supply/mapping-index.loader'
import { SupplierPromotionDatabase } from './supplier-promotion.database'

export class PromotionRefused extends Error {
  constructor(readonly code: 'PROFILE_UNKNOWN' | 'INVALID_INPUT') { super(`Promotion refused (${code})`); this.name = 'PromotionRefused' }
}

export interface PromotionInput {
  tenantId: string
  supplierId: string
  /** The connector whose latest delivery is promoted. Observations are latest-state, so only the rows the latest applied run wrote say what that delivery mentioned. */
  connectorId: string
  profileKey: string
  /** Stable across retries of the same promotion: 8-128 of [A-Za-z0-9_-]. */
  idempotencyKey: string
  now: Date
}
export interface PromotionOutcome {
  runId: string
  status: SupplierPromotionStatus
  replayed: boolean
  ratesConsidered: number
  ratesPromoted: number
  stockConsidered: number
  nightsPromoted: number
  poolNightsPromoted: number
  nightsClosed: number
  summary: Record<string, number>
}

const KEY = /^[A-Za-z0-9_-]{8,128}$/
const SUMMARY_LIMIT = 60
const iso = (d: Date) => d.toISOString().slice(0, 10)
const date = (s: string) => new Date(`${s}T00:00:00.000Z`)
const DAY_MS = 86_400_000
const addDays = (s: string, n: number) => iso(new Date(date(s).getTime() + n * DAY_MS))

interface StockStatement { planId: string; roomPlanIds: string[] | null; poolId: string | null; night: string; mode: InventoryMode; available: number | null; stopSell: boolean; releaseDays: number | null; receivedAt: Date; freshUntil: Date }

/**
 * Promotes ingested observations into contracted rates, availability and pool capacity (ADR 0084), applying the rules the owner decided in ADR 0082 and 0083. One transaction per call, on the
 * narrow promotion role, serialized per tenant and supplier, idempotent per key, with run evidence and a SYSTEM audit event written in the same transaction.
 *
 * Nothing is inferred: observations resolve only through approved mappings; a rate must be NET (declared), tax-inclusive (stated), AED and positive; a stock count needs declared semantics;
 * a room-wide statement needs one active pool; a person's close is never reopened by the feed; and the whole batch is held, writing nothing, when any night moves more than 30% or more than 20%
 * of the previously priced nights are missing. Restrictions (minimum stay, closed to arrival and departure), `sold` and `held` are never written.
 */
@Injectable()
export class SupplierPromotionService {
  private readonly logger = new Logger(SupplierPromotionService.name)

  constructor(private readonly db: SupplierPromotionDatabase, private readonly profiles: IngestProfileRegistry) {}

  async promote(input: PromotionInput): Promise<PromotionOutcome> {
    if (!input.tenantId || !input.supplierId || !input.connectorId || !KEY.test(input.idempotencyKey) || !Number.isFinite(input.now.getTime())) throw new PromotionRefused('INVALID_INPUT')
    const profile = this.profiles.get(input.profileKey)
    if (!profile) throw new PromotionRefused('PROFILE_UNKNOWN')
    const outcome = await this.db.withTenant(input.tenantId, (tx) => this.run(tx, input, profile))
    this.logger.log(`Promotion ${outcome.status}${outcome.replayed ? ' (replayed)' : ''}: rates=${outcome.ratesPromoted}/${outcome.ratesConsidered} nights=${outcome.nightsPromoted} poolNights=${outcome.poolNightsPromoted} closed=${outcome.nightsClosed}`)
    return outcome
  }

  private async run(tx: Prisma.TransactionClient, input: PromotionInput, profile: NonNullable<ReturnType<IngestProfileRegistry['get']>>): Promise<PromotionOutcome> {
    const { tenantId, supplierId, idempotencyKey, now } = input
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`promote|${tenantId}|${supplierId}`}, 0))`
    const prior = await tx.supplierPromotionRun.findFirst({ where: { tenantId, supplierId, idempotencyKey } })
    if (prior) {
      return { runId: prior.id, status: prior.status, replayed: true, ratesConsidered: prior.ratesConsidered, ratesPromoted: prior.ratesPromoted, stockConsidered: prior.stockConsidered, nightsPromoted: prior.nightsPromoted, poolNightsPromoted: prior.poolNightsPromoted, nightsClosed: prior.nightsClosed, summary: prior.summary as Record<string, number> }
    }

    const index = await loadMappingIndex(tx, tenantId, supplierId)
    const summary: Record<string, number> = {}
    const bump = (code: string, n = 1) => { const key = code in summary || Object.keys(summary).length < SUMMARY_LIMIT ? code : 'OTHER'; summary[key] = (summary[key] ?? 0) + n }

    // The latest APPLIED delivery of each kind for this connector. A night an earlier delivery mentioned and this one did not keeps its old row (ADR 0078), but not this run id, so it is
    // neither promoted again nor counted as mentioned: that is what lets a dropped night be seen (ADR 0083 decision 4).
    const latest = async (kind: 'RATES' | 'ALLOTMENTS') => (await tx.supplierIngestRun.findFirst({ where: { tenantId, supplierId, connectorId: input.connectorId, kind, applied: true }, orderBy: { receivedAt: 'desc' }, select: { id: true } }))?.id ?? null
    const [ratesRunId, stockRunId] = await Promise.all([latest('RATES'), latest('ALLOTMENTS')])
    const [rateObs, stockObs] = await Promise.all([
      ratesRunId ? tx.supplierRateObservation.findMany({ where: { tenantId, supplierId, runId: ratesRunId, freshUntil: { gt: now } } }) : [],
      stockRunId ? tx.supplierAllotmentObservation.findMany({ where: { tenantId, supplierId, runId: stockRunId, freshUntil: { gt: now } } }) : [],
    ])

    const hotelRows = [...index.hotels.values()]
    const hotels = await tx.hotel.findMany({ where: { tenantId, id: { in: hotelRows.map((h) => h.hotelId) } }, select: { id: true, timeZone: true } })
    const todayOfHotel = new Map(hotels.map((h) => [h.id, dayInZone(now, h.timeZone)]))
    const hotelMappingOfRoom = new Map([...index.rooms.values()].map((r) => [r.id, r.supplierHotelMappingId]))
    const hotelIdOfMapping = new Map(hotelRows.map((h) => [h.id, h.hotelId]))
    const hotelOfPlan = new Map<string, string>()
    for (const p of index.plans.values()) { const hm = hotelMappingOfRoom.get(p.roomMappingId); const h = hm ? hotelIdOfMapping.get(hm) : undefined; if (h) hotelOfPlan.set(p.ratePlanId, h) }
    const todayOf = (planId: string) => todayOfHotel.get(hotelOfPlan.get(planId) ?? '') ?? iso(now)

    const planIds = [...new Set([...index.plans.values()].filter((p) => p.status === 'MAPPED').map((p) => p.ratePlanId))]
    const planRows = planIds.length === 0 ? [] : await tx.ratePlan.findMany({ where: { tenantId, id: { in: planIds } }, select: { id: true, currency: true, taxesIncluded: true, occupancy: true, derivedFromId: true, inventoryPoolId: true } })
    const plans = new Map(planRows.map((p) => [p.id, p]))
    const poolIds = [...new Set(planRows.map((p) => p.inventoryPoolId).filter((id): id is string => !!id))]
    const pools = new Map((poolIds.length === 0 ? [] : await tx.inventoryPool.findMany({ where: { tenantId, id: { in: poolIds } }, select: { id: true, status: true } })).map((p) => [p.id, p.status]))
    const enabled = enabledSettlementCurrencies()

    // ---- Rates (ADR 0082) ----
    const rateWrites: Array<{ planId: string; night: string; amount: bigint; occupancy: number; receivedAt: Date }> = []
    for (const o of rateObs) {
      const resolved = resolveRate({ supplierHotelCode: o.supplierHotelCode, supplierRoomCode: o.supplierRoomCode, supplierRatePlanCode: o.supplierRatePlanCode, currency: o.currency, taxesIncluded: o.taxesIncluded, freshUntil: o.freshUntil }, index, now)
      if (!resolved.ok) { bump(resolved.reason); continue }
      const plan = plans.get(resolved.target.ratePlanId)
      if (!plan || plan.derivedFromId !== null) { bump('PLAN_DERIVED'); continue }
      const block = checkRatePromotable({ profileBasis: profile.amountBasis, observation: { taxesIncluded: o.taxesIncluded, currency: o.currency, netMinor: o.netMinor }, plan: { taxesIncluded: plan.taxesIncluded, currency: plan.currency }, enabledCurrencies: enabled })
      if (block) { bump(block); continue }
      const night = iso(o.stayDate)
      if (night < todayOf(plan.id)) { bump('PAST_NIGHT'); continue }
      rateWrites.push({ planId: plan.id, night, amount: o.netMinor, occupancy: plan.occupancy, receivedAt: o.receivedAt })
    }
    const ratePlanSet = [...new Set(rateWrites.map((r) => r.planId))]
    const existingRates = ratePlanSet.length === 0 ? [] : await tx.dailyRate.findMany({ where: { tenantId, ratePlanId: { in: ratePlanSet }, stayDate: { gte: date(rateWrites.reduce((m, r) => (r.night < m ? r.night : m), rateWrites[0].night)) } } })
    const rateKey = (planId: string, night: string, occupancy: number) => `${planId}|${night}|${occupancy}`
    const existingByKey = new Map(existingRates.map((r) => [rateKey(r.ratePlanId, iso(r.stayDate), r.occupancy), r]))
    // The guard compares what is stored now with what the batch says, per plan, over the nights the feed claims to cover.
    const incoming = new Map<string, bigint>(rateWrites.map((r) => [`${r.planId}|${r.night}`, r.amount]))
    const previous = new Map<string, bigint>()
    for (const planId of ratePlanSet) {
      const plan = plans.get(planId)!
      const mine = rateWrites.filter((r) => r.planId === planId)
      const from = todayOf(planId)
      const to = profile.coverageDays ? addDays(from, profile.coverageDays) : mine.reduce((m, r) => (r.night > m ? r.night : m), mine[0].night)
      for (const r of existingRates) if (r.ratePlanId === planId && r.occupancy === plan.occupancy) { const n = iso(r.stayDate); if (n >= from && n <= to) previous.set(`${planId}|${n}`, r.amountMinor) }
    }
    const guard = evaluateBatchGuard(previous, incoming)

    const finish = async (status: SupplierPromotionStatus, counts: { ratesPromoted: number; nightsPromoted: number; poolNightsPromoted: number; nightsClosed: number }, stockConsidered: number): Promise<PromotionOutcome> => {
      const run = await tx.supplierPromotionRun.create({ data: { tenantId, supplierId, idempotencyKey, profileKey: profile.key, status, ratesConsidered: rateObs.length, stockConsidered, summary, ...counts }, select: { id: true } })
      const action = status === 'APPLIED' ? 'applied' : status === 'HELD' ? 'held' : 'nothing'
      // createMany: no RETURNING, so a role with INSERT-only access to the audit log can write it.
      await tx.auditEvent.createMany({ data: [{ tenantId, userId: null, actorType: 'SYSTEM', action: `supplier.promotion.${action}`, entityType: 'supplier_promotion_run', entityId: run.id, payload: { supplierId, profileKey: profile.key, ratesConsidered: rateObs.length, stockConsidered, ...counts, summary } }] })
      return { runId: run.id, status, replayed: false, ratesConsidered: rateObs.length, stockConsidered, ...counts, summary }
    }

    if (guard.hold) {
      for (const reason of guard.reasons) bump(`HELD_${reason}`)
      bump('HELD_LARGE_MOVES', guard.largeMoves); bump('HELD_DROPPED_NIGHTS', guard.droppedNights)
      return finish('HELD', { ratesPromoted: 0, nightsPromoted: 0, poolNightsPromoted: 0, nightsClosed: 0 }, stockObs.length)
    }

    // ---- Stock (ADR 0083) ----
    const statements: StockStatement[] = []
    const poolNights = new Map<string, StockStatement & { count: number | null }>()
    for (const o of stockObs) {
      const resolved = resolveAllotment({ supplierHotelCode: o.supplierHotelCode, supplierRoomCode: o.supplierRoomCode, supplierRatePlanCode: o.supplierRatePlanCode, freshUntil: o.freshUntil }, index, now)
      if (!resolved.ok) { bump(resolved.reason); continue }
      const base = { night: iso(o.stayDate), mode: o.mode, available: o.available, stopSell: o.stopSell, releaseDays: o.releaseDays, receivedAt: o.receivedAt, freshUntil: o.freshUntil }
      if (resolved.target.ratePlanId !== null) {
        const plan = plans.get(resolved.target.ratePlanId)
        if (!plan || plan.derivedFromId !== null) { bump('PLAN_DERIVED'); continue }
        if (plan.inventoryPoolId) { bump('POOLED_PLAN_STOCK_NEEDS_ROOM_WIDE'); continue }
        if (base.night < todayOf(plan.id)) { bump('PAST_NIGHT'); continue }
        statements.push({ ...base, planId: plan.id, roomPlanIds: null, poolId: null })
        continue
      }
      const roomPlans = [...index.plans.values()].filter((p) => p.roomMappingId === resolved.target.roomMappingId && p.status === 'MAPPED').map((p) => p.ratePlanId)
      const route = routeRoomWideStock(roomPlans.map((id) => { const pl = plans.get(id); return { ratePlanId: id, poolId: pl?.inventoryPoolId ?? null, poolActive: pl?.inventoryPoolId ? pools.get(pl.inventoryPoolId) === 'ACTIVE' : false } }))
      if (!route.ok) { bump(route.block); continue }
      if (base.night < todayOf(roomPlans[0])) { bump('PAST_NIGHT'); continue }
      const key = `${route.poolId}|${base.night}`
      const seen = poolNights.get(key)
      if (seen && (seen.available !== base.available || seen.mode !== base.mode || seen.stopSell !== base.stopSell)) { poolNights.delete(key); bump('POOL_NIGHT_CONFLICT'); continue }
      if (seen) continue
      poolNights.set(key, { ...base, planId: roomPlans[0], roomPlanIds: roomPlans, poolId: route.poolId, count: base.available })
    }
    const roomStatements = [...poolNights.values()]
    const stockConsidered = stockObs.length

    const stockPlanIds = [...new Set([...statements.map((s) => s.planId), ...roomStatements.flatMap((s) => s.roomPlanIds ?? [])])]
    const stockNights = [...new Set([...statements.map((s) => s.night), ...roomStatements.map((s) => s.night)])]
    const availRows = stockPlanIds.length === 0 ? [] : await tx.dailyAvailability.findMany({ where: { tenantId, ratePlanId: { in: stockPlanIds }, stayDate: { gte: date(stockNights.reduce((m, n) => (n < m ? n : m), stockNights[0])) } } })
    const availKey = (planId: string, night: string) => `${planId}|${night}`
    const availByKey = new Map(availRows.map((r) => [availKey(r.ratePlanId, iso(r.stayDate)), r]))
    const poolDayRows = poolIds.length === 0 || roomStatements.length === 0 ? [] : await tx.inventoryPoolDay.findMany({ where: { tenantId, poolId: { in: [...new Set(roomStatements.map((s) => s.poolId as string))] } } })
    const poolDayByKey = new Map(poolDayRows.map((r) => [`${r.poolId}|${iso(r.stayDate)}`, r]))

    // Nothing at all to write: record it, change nothing.
    if (rateWrites.length === 0 && statements.length === 0 && roomStatements.length === 0) return finish('NOTHING_TO_PROMOTE', { ratesPromoted: 0, nightsPromoted: 0, poolNightsPromoted: 0, nightsClosed: 0 }, stockConsidered)

    // ---- Writes ----
    let ratesPromoted = 0
    const newRates: Prisma.DailyRateCreateManyInput[] = []
    for (const r of rateWrites) {
      const cur = existingByKey.get(rateKey(r.planId, r.night, r.occupancy))
      const plan = plans.get(r.planId)!
      if (!cur) { newRates.push({ tenantId, ratePlanId: r.planId, stayDate: date(r.night), occupancy: r.occupancy, amountMinor: r.amount, amountBasis: 'NET', currency: plan.currency, sourceVersion: idempotencyKey, sourceUpdatedAt: r.receivedAt }); ratesPromoted++ }
      else if (cur.amountMinor !== r.amount || cur.amountBasis !== 'NET' || cur.currency !== plan.currency) {
        await tx.dailyRate.update({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: r.planId, stayDate: date(r.night), occupancy: r.occupancy }, tenantId }, data: { amountMinor: r.amount, amountBasis: 'NET', currency: plan.currency, sourceVersion: idempotencyKey, sourceUpdatedAt: r.receivedAt } })
        ratesPromoted++
      }
    }
    if (newRates.length) await tx.dailyRate.createMany({ data: newRates })

    let nightsPromoted = 0
    let poolNightsPromoted = 0
    const writePlanNight = async (planId: string, s: StockStatement, allotmentFor: (cur: { allotment: number; sold: number; held: number } | null) => number | null): Promise<void> => {
      const cur = availByKey.get(availKey(planId, s.night)) ?? null
      const state: NightState | null = cur ? { source: cur.source, stopSell: cur.stopSell, mode: cur.inventoryMode } : null
      if (!mayFeedWriteNight(state, { stopSell: s.stopSell, mode: s.mode }).allowed) { bump('SKIPPED_MANUAL_CLOSE'); return }
      const allotment = allotmentFor(cur)
      if (allotment === null) return
      const provenance = { source: 'SUPPLIER_FEED' as const, sourceUpdatedAt: s.receivedAt, receivedAt: s.receivedAt, freshUntil: s.freshUntil }
      if (cur) await tx.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: date(s.night) }, tenantId }, data: { allotment, stopSell: s.stopSell, inventoryMode: s.mode, ...(s.releaseDays !== null ? { releaseDays: s.releaseDays } : {}), ...provenance } })
      else await tx.dailyAvailability.create({ data: { tenantId, ratePlanId: planId, stayDate: date(s.night), allotment, sold: 0, held: 0, stopSell: s.stopSell, releaseDays: s.releaseDays, inventoryMode: s.mode, ...provenance } })
      nightsPromoted++
    }
    for (const s of statements) {
      await writePlanNight(s.planId, s, (cur) => {
        if (s.mode !== 'ALLOTMENT') return cur?.allotment ?? 0
        const planned = planStockCount({ semantics: profile.allotmentSemantics, count: s.available ?? -1, sold: cur?.sold ?? 0, held: cur?.held ?? 0 })
        if (!planned.ok) { bump(planned.block); return null }
        return planned.allotment
      })
    }
    for (const s of roomStatements) {
      if (s.mode === 'ALLOTMENT') {
        const day = poolDayByKey.get(`${s.poolId}|${s.night}`)
        const planned = planStockCount({ semantics: profile.allotmentSemantics, count: s.available ?? -1, sold: day?.sold ?? 0, held: day?.held ?? 0 })
        if (!planned.ok) { bump(planned.block); continue }
        const provenance = { source: 'SUPPLIER_FEED' as const, sourceUpdatedAt: s.receivedAt, receivedAt: s.receivedAt, freshUntil: s.freshUntil }
        if (day) await tx.inventoryPoolDay.update({ where: { poolId_stayDate: { poolId: s.poolId as string, stayDate: date(s.night) }, tenantId }, data: { capacity: planned.allotment, ...provenance } })
        else await tx.inventoryPoolDay.create({ data: { tenantId, poolId: s.poolId as string, stayDate: date(s.night), capacity: planned.allotment, sold: 0, held: 0, ...provenance } })
        poolNightsPromoted++
      }
      // A pooled plan's own row carries mode and stop-sell; its own count is ignored (ADR 0030), so a new row starts at zero.
      for (const planId of s.roomPlanIds ?? []) await writePlanNight(planId, s, (cur) => cur?.allotment ?? 0)
    }

    // Omitted nights (ADR 0083 decision 4): only for plans this batch made a statement about, and only for nights a feed previously promoted.
    let nightsClosed = 0
    const incomingByPlan = new Map<string, Set<string>>()
    for (const s of statements) incomingByPlan.set(s.planId, (incomingByPlan.get(s.planId) ?? new Set()).add(s.night))
    for (const s of roomStatements) for (const id of s.roomPlanIds ?? []) incomingByPlan.set(id, (incomingByPlan.get(id) ?? new Set()).add(s.night))
    for (const [planId, nights] of incomingByPlan) {
      const promoted = new Map<string, NightState>()
      for (const r of availRows) if (r.ratePlanId === planId && r.source === 'SUPPLIER_FEED') promoted.set(iso(r.stayDate), { source: r.source, stopSell: r.stopSell, mode: r.inventoryMode })
      for (const night of omittedNightsToClose({ promoted, incomingNights: nights, today: todayOf(planId), coverageDays: profile.coverageDays })) {
        await tx.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: date(night) }, tenantId }, data: { inventoryMode: 'CLOSED', source: 'SUPPLIER_FEED', sourceUpdatedAt: now, receivedAt: now, freshUntil: new Date(now.getTime() + profile.freshnessMs) } })
        nightsClosed++
      }
    }
    if (nightsClosed > 0) bump('NIGHTS_CLOSED_OMITTED', nightsClosed)

    // A run that wrote nothing (everything blocked or skipped) is recorded as such, never as an applied promotion.
    const wrote = ratesPromoted + nightsPromoted + poolNightsPromoted + nightsClosed > 0
    return finish(wrote ? 'APPLIED' : 'NOTHING_TO_PROMOTE', { ratesPromoted, nightsPromoted, poolNightsPromoted, nightsClosed }, stockConsidered)
  }
}

