import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import type { HotelOperationsRow, HotelReadiness, OperationsReadiness, Paged, SupplierOperationsRow } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { evaluateNightSellability, type NightSellabilityPlan } from '../supply/contracted-sellability'
import { day, sectionRead } from './operations-read'
import { dayParam, enumParam, idParam, intParam, pageParams, paged, textParam } from './query-params'
import { DEFAULT_STALE_MINUTES } from './booking-attention'

const CONTENT_STATUSES = ['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED'] as const
const MAPPING_FILTERS = ['MAPPED', 'PENDING', 'REJECTED', 'NONE'] as const
const READINESS = ['READY', 'BLOCKED', 'NOT_CONFIGURED'] as const
const SUPPLIER_STATUSES = ['DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'INACTIVE'] as const
const DEFAULT_WINDOW_DAYS = 30
const MAX_WINDOW_DAYS = 90
const READINESS_HOTEL_CAP = 500
const NIGHT_MS = 86_400_000

export const READINESS_DEFINITIONS: Record<string, string> = {
  sellable: 'A hotel is sellable when at least one of its rate plans has at least one night in the window that passes every canonical commercial gate (evaluateNightSellability) and, where a supplier mapping exists, an approved room mapping.',
  blocked: 'Rate plans exist but no night in the window passes the gates. The most frequent reason codes are listed per hotel.',
  notConfigured: 'The hotel has no rate plan at all.',
  rateGapHotels: 'Hotels with at least one active rate plan night in the window that has no daily rate.',
  availabilityGapHotels: 'Hotels with at least one active rate plan night in the window that has no availability row.',
  stopSellHotels: 'Hotels with at least one night in the window on stop-sell.',
  reconciliationRequired: 'Bookings flagged RECONCILIATION_REQUIRED or PREBOOK_EXPIRED_UNRESOLVED by the consistency rules.',
}

type Counts = { total: number; mapped: number; pending: number; rejected: number }
const emptyCounts = (): Counts => ({ total: 0, mapped: 0, pending: 0, rejected: 0 })
const addStatus = (c: Counts, status: string, n: number) => { c.total += n; if (status === 'MAPPED') c.mapped += n; else if (status === 'PENDING') c.pending += n; else if (status === 'REJECTED') c.rejected += n }

interface HotelEval { readiness: HotelReadiness; blockers: string[]; rateGap: boolean; availabilityGap: boolean; stopSell: boolean }

/** Read-only supply views. Per-hotel sellability reuses the one canonical night evaluator; nothing is recomputed in the browser. */
@Injectable()
export class OperationsSupplyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Same fail-closed rule as SupplyService: formal role permissions only. */
  private async require(tenantId: string, userId: string, permission: string) {
    const roles = await this.prisma.withTenant(tenantId, tx => tx.userRole.findMany({ where: { tenantId, userId, role: { tenantId } }, include: { role: { include: { permissions: { include: { permission: true } } } } } }))
    const keys = roles.flatMap(r => r.role.permissions.map(p => p.permission.key))
    if (!keys.includes(permission)) throw new ForbiddenException('Insufficient permission')
  }

  private window(query: Record<string, unknown>) {
    const from = dayParam('from', query.from) ?? new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)
    const days = intParam('days', query.days, 1, MAX_WINDOW_DAYS) ?? DEFAULT_WINDOW_DAYS
    return { from, days, to: new Date(from.getTime() + (days - 1) * NIGHT_MS) }
  }

  private async evaluate(tx: Prisma.TransactionClient, tenantId: string, hotelIds: string[], from: Date, days: number): Promise<Map<string, HotelEval>> {
    const result = new Map<string, HotelEval>()
    for (const id of hotelIds) result.set(id, { readiness: 'NOT_CONFIGURED', blockers: [], rateGap: false, availabilityGap: false, stopSell: false })
    if (hotelIds.length === 0) return result
    const to = new Date(from.getTime() + (days - 1) * NIGHT_MS)
    const plans = await tx.ratePlan.findMany({
      where: { tenantId, roomType: { hotelId: { in: hotelIds } } },
      include: {
        roomType: { include: { hotel: true } }, boardBasis: true, contract: { include: { supplier: true, supplierHotelMapping: true } },
        dailyRates: { where: { tenantId, stayDate: { gte: from, lte: to } } }, availability: { where: { tenantId, stayDate: { gte: from, lte: to } } },
      },
    })
    const roomMappings = await tx.supplierRoomMapping.findMany({ where: { tenantId, status: 'MAPPED', hotelId: { in: hotelIds } }, select: { supplierHotelMappingId: true, roomTypeId: true } })
    const mapped = new Set(roomMappings.map(m => `${m.supplierHotelMappingId}:${m.roomTypeId}`))
    const reasonCounts = new Map<string, Map<string, number>>()
    const sellable = new Set<string>()
    for (const plan of plans) {
      const hotelId = plan.roomType.hotelId
      const state = result.get(hotelId)
      if (!state) continue
      if (state.readiness === 'NOT_CONFIGURED') state.readiness = 'BLOCKED'
      const counts = reasonCounts.get(hotelId) ?? new Map<string, number>()
      reasonCounts.set(hotelId, counts)
      const rates = new Map(plan.dailyRates.filter(r => r.occupancy === plan.occupancy).map(r => [day(r.stayDate), r]))
      const avail = new Map(plan.availability.map(a => [day(a.stayDate), a]))
      for (let i = 0; i < days; i++) {
        const stayDate = new Date(from.getTime() + i * NIGHT_MS)
        const key = day(stayDate)
        const rate = rates.get(key); const a = avail.get(key)
        if (plan.status === 'ACTIVE') { if (!rate) state.rateGap = true; if (!a) state.availabilityGap = true }
        if (a?.stopSell) state.stopSell = true
        const nightPlan: NightSellabilityPlan = { status: plan.status, occupancy: plan.occupancy, currency: plan.currency, roomType: plan.roomType, boardBasis: plan.boardBasis, contract: plan.contract, dailyRates: rate ? [rate] : [], availability: a ? [a] : [] }
        const reasons = evaluateNightSellability(nightPlan, { stayDate, occupancy: plan.occupancy })
        const hm = plan.contract.supplierHotelMapping
        if (hm && hm.hotelId === hotelId && hm.status === 'MAPPED' && !mapped.has(`${hm.id}:${plan.roomTypeId}`)) reasons.push('ROOM_MAPPING_UNAPPROVED')
        if (reasons.length === 0) sellable.add(hotelId)
        for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1)
      }
    }
    for (const [id, state] of result) {
      if (sellable.has(id)) state.readiness = 'READY'
      state.blockers = [...(reasonCounts.get(id) ?? new Map())].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 5).map(([code]) => code)
    }
    return result
  }

  async hotels(tenantId: string, userId: string, query: Record<string, unknown>): Promise<Paged<HotelOperationsRow>> {
    await this.require(tenantId, userId, 'supply.hotels.read')
    const page = pageParams(query)
    const search = textParam('search', query.search, 64)
    const contentStatus = enumParam('contentStatus', query.contentStatus, CONTENT_STATUSES)
    const supplierId = idParam('supplierId', query.supplierId)
    const mapping = enumParam('mapping', query.mapping, MAPPING_FILTERS)
    const readiness = enumParam('readiness', query.readiness, READINESS)
    const { from, days } = this.window(query)
    const mappingWhere: Prisma.HotelWhereInput = mapping === 'NONE' ? { mappings: { none: {} } } : mapping ? { mappings: { some: { status: mapping, ...(supplierId && { supplierId }) } } } : supplierId ? { mappings: { some: { supplierId } } } : {}
    const base: Prisma.HotelWhereInput = { tenantId, ...(contentStatus && { contentStatus }), ...(search && { name: { startsWith: search, mode: 'insensitive' } }), ...mappingWhere }
    return this.prisma.withTenant(tenantId, async tx => {
      // Readiness is evaluated, so a readiness filter is applied over the (bounded) tenant hotel set before paging.
      if (readiness) {
        const all = await tx.hotel.findMany({ where: base, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: READINESS_HOTEL_CAP })
        const evals = await this.evaluate(tx, tenantId, all.map(h => h.id), from, days)
        const kept = all.filter(h => evals.get(h.id)?.readiness === readiness)
        return paged(await this.hotelRows(tx, tenantId, kept.slice(page.skip, page.skip + page.take), evals), page, kept.length)
      }
      const [rows, total] = await Promise.all([tx.hotel.findMany({ where: base, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take }), tx.hotel.count({ where: base })])
      const evals = await this.evaluate(tx, tenantId, rows.map(h => h.id), from, days)
      return paged(await this.hotelRows(tx, tenantId, rows, evals), page, total)
    })
  }

  private async hotelRows(tx: Prisma.TransactionClient, tenantId: string, hotels: Array<{ id: string; name: string; city: string; countryCode: string; contentStatus: string }>, evals: Map<string, HotelEval>): Promise<HotelOperationsRow[]> {
    const ids = hotels.map(h => h.id)
    if (ids.length === 0) return []
    const [rooms, plans, maps] = await Promise.all([
      tx.roomType.groupBy({ by: ['hotelId'], where: { hotel: { tenantId }, hotelId: { in: ids } }, _count: { id: true } }),
      tx.ratePlan.findMany({ where: { tenantId, roomType: { hotelId: { in: ids } } }, select: { roomType: { select: { hotelId: true } } } }),
      tx.supplierHotelMapping.groupBy({ by: ['hotelId', 'status'], where: { tenantId, hotelId: { in: ids } }, _count: { _all: true } }),
    ])
    const roomCount = new Map(rooms.map(r => [r.hotelId, r._count?.id ?? 0]))
    const planCount = new Map<string, number>(); for (const p of plans) planCount.set(p.roomType.hotelId, (planCount.get(p.roomType.hotelId) ?? 0) + 1)
    const mapCounts = new Map<string, Counts>(); for (const m of maps) { const c = mapCounts.get(m.hotelId) ?? emptyCounts(); addStatus(c, m.status, m._count._all); mapCounts.set(m.hotelId, c) }
    return hotels.map(h => ({ id: h.id, name: h.name, city: h.city, countryCode: h.countryCode, contentStatus: h.contentStatus, rooms: roomCount.get(h.id) ?? 0, ratePlans: planCount.get(h.id) ?? 0, mappings: mapCounts.get(h.id) ?? emptyCounts(), readiness: evals.get(h.id)?.readiness, blockers: evals.get(h.id)?.blockers }))
  }

  async suppliers(tenantId: string, userId: string, query: Record<string, unknown>): Promise<Paged<SupplierOperationsRow>> {
    await this.require(tenantId, userId, 'supply.suppliers.read')
    const page = pageParams(query)
    const search = textParam('search', query.search, 64)
    const status = enumParam('status', query.status, SUPPLIER_STATUSES)
    const where: Prisma.SupplierWhereInput = { tenantId, ...(status && { status }), ...(search && { displayName: { startsWith: search, mode: 'insensitive' } }) }
    return this.prisma.withTenant(tenantId, async tx => {
      const [rows, total] = await Promise.all([tx.supplier.findMany({ where, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take }), tx.supplier.count({ where })])
      const ids = rows.map(r => r.id)
      const [hm, rm, contracts] = ids.length ? await Promise.all([
        tx.supplierHotelMapping.groupBy({ by: ['supplierId', 'status'], where: { tenantId, supplierId: { in: ids } }, _count: { _all: true } }),
        tx.supplierRoomMapping.findMany({ where: { tenantId, supplierHotelMapping: { supplierId: { in: ids } } }, select: { status: true, supplierHotelMapping: { select: { supplierId: true } } } }),
        tx.contract.groupBy({ by: ['supplierId', 'status'], where: { tenantId, supplierId: { in: ids } }, _count: { _all: true } }),
      ]) : [[], [], []]
      return paged(rows.map(s => {
        const h = emptyCounts(); for (const m of hm) if (m.supplierId === s.id) addStatus(h, m.status, m._count._all)
        const r = emptyCounts(); for (const m of rm) if (m.supplierHotelMapping.supplierId === s.id) addStatus(r, m.status, 1)
        const c = { total: 0, active: 0 }; for (const x of contracts) if (x.supplierId === s.id) { c.total += x._count._all; if (x.status === 'ACTIVE') c.active += x._count._all }
        return { id: s.id, displayName: s.displayName, legalName: s.legalName, type: s.type, status: s.status, countryCode: s.countryCode, defaultCurrency: s.defaultCurrency, hotelMappings: h, roomMappings: r, contracts: c, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() }
      }), page, total)
    })
  }

  async readiness(tenantId: string, userId: string, query: Record<string, unknown>, transactions: () => Promise<OperationsReadiness['transactions']>, connectors: () => Promise<OperationsReadiness['connectors']>): Promise<OperationsReadiness> {
    await this.require(tenantId, userId, 'supply.hotels.read')
    if (query.from !== undefined && typeof query.from !== 'string') throw new BadRequestException('Invalid from')
    const { from, days, to } = this.window(query)
    const supply = await sectionRead(() => this.prisma.withTenant(tenantId, async tx => {
      const hotels = await tx.hotel.findMany({ where: { tenantId }, select: { id: true }, take: READINESS_HOTEL_CAP })
      const evals = await this.evaluate(tx, tenantId, hotels.map(h => h.id), from, days)
      const [suppliers, activeSuppliers, hm, rm] = await Promise.all([
        tx.supplier.count({ where: { tenantId } }), tx.supplier.count({ where: { tenantId, status: 'ACTIVE' } }),
        tx.supplierHotelMapping.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
        tx.supplierRoomMapping.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
      ])
      const h = emptyCounts(); for (const m of hm) addStatus(h, m.status, m._count._all)
      const r = emptyCounts(); for (const m of rm) addStatus(r, m.status, m._count._all)
      const states = [...evals.values()]
      return {
        suppliers: { total: suppliers, active: activeSuppliers },
        hotels: { configured: states.filter(s => s.readiness !== 'NOT_CONFIGURED').length, sellable: states.filter(s => s.readiness === 'READY').length, blocked: states.filter(s => s.readiness === 'BLOCKED').length, notConfigured: states.filter(s => s.readiness === 'NOT_CONFIGURED').length },
        hotelMappings: { mapped: h.mapped, pending: h.pending, rejected: h.rejected }, roomMappings: { mapped: r.mapped, pending: r.pending, rejected: r.rejected },
        rateGapHotels: states.filter(s => s.rateGap).length, availabilityGapHotels: states.filter(s => s.availabilityGap).length, stopSellHotels: states.filter(s => s.stopSell).length,
      }
    }))
    return {
      generatedAt: new Date().toISOString(), window: { from: day(from), to: day(to), days },
      definitions: { ...READINESS_DEFINITIONS, staleMinutes: `A claimed hold stuck in PROCESSING for ${DEFAULT_STALE_MINUTES} minutes or more needs reconciliation.` },
      supply, transactions: await transactions(), connectors: await connectors(),
    }
  }
}
