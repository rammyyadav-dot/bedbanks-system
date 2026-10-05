import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  CERTIFICATION_STATUSES, HOTEL_DISTRIBUTION_STATUSES, RATE_CERTIFICATION_LIMITS, RATE_FINDING_CODES, REMEDIATION_PRIORITIES,
  type CertificationStatus, type HotelCertificationPage, type HotelDistributionStatus, type MarkupRuleAudit, type RateCertificationReport, type RateCertificationSummary,
  type RateFindingCode, type RatePlanAuditDetail, type RatePlanAuditRow, type RateCertificationPlansPage, type RateRowClassCounts, type RemediationItem, type RemediationPriority, type RemediationQueue, type SimulateRequest, type SimulationResult,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { enabledSettlementCurrencies } from '../agent/currency'
import { CommercialControlUnavailableError } from '../supply/commercial-controls'
import { loadActiveMarkupRulesInTx } from '../supply/markup-rules.loader'
import { mappingFor, windowDates, type AssessContract } from '../supply/commercial-assessment'
import { stayDates, stayNightCount } from '../supply/contracted-sellability'
import { day } from '../admin-operations/operations-read'
import { dayParam, enumParam, idParam, intParam, pageParams, paged, textParam } from '../admin-operations/query-params'
import { auditHotel, auditMarkupRules, markupRemediation, remediationItems, simulateStay, type AuditHotelInput, type AuditPlan, type HotelAudit } from './rate-plan-audit'
import { renderMarkdownReport } from './rate-certification-report'

type Q = Record<string, unknown>
type Win = { from: string; days: number; to: string; dates: string[] }
const L = RATE_CERTIFICATION_LIMITS
const HOTEL_SELECT = { id: true, name: true, city: true, starRating: true, contentStatus: true } as const
type HotelRow = { id: string; name: string; city: string; starRating: number | null; contentStatus: string }

interface Scan {
  generatedAt: string
  win: Win
  hotels: HotelAudit[]
  plans: RatePlanAuditRow[]
  markup: MarkupRuleAudit
  remediation: RemediationItem[]
  scanCapped: boolean
  totalHotels: number
}

const emptyClasses = (): RateRowClassCounts => ({ VALID: 0, QUARANTINED: 0, DEAD: 0, OUTSIDE_CONTRACT: 0, BLOCKED_NO_MARKUP: 0 })

/**
 * Read-only rate plan audit and distribution certification (ADR 0033). It loads the same rows the Agent search prices from, runs the
 * pure audit over them and returns observations. It writes nothing, repairs nothing and sets no flag the search reads.
 * Every read runs inside the caller's tenant transaction (RLS) and uses only tables the strict runtime role can already SELECT.
 */
@Injectable()
export class RateCertificationService {
  /** Replaceable in tests so date-dependent behaviour is deterministic. */
  clock: () => Date = () => new Date()
  /** Replaceable in tests; production uses the contract limit. */
  planNightBudget: number = L.maxPlanNights

  constructor(private readonly prisma: PrismaService) {}

  private today(): string { return this.clock().toISOString().slice(0, 10) }

  private window(query: Q): Win {
    const fromDate = dayParam('from', query.from)
    const from = fromDate ? day(fromDate) : this.today()
    const days = intParam('days', query.days, 1, L.maxDays) ?? L.defaultDays
    const dates = windowDates(from, days)
    return { from, days, to: dates[dates.length - 1], dates }
  }

  // ---- loading ---------------------------------------------------------------------------------------------------------------
  private async loadInputs(tx: Prisma.TransactionClient, tenantId: string, hotels: HotelRow[], win: Win, rules: AuditHotelInput['markupRules']): Promise<AuditHotelInput[]> {
    if (hotels.length === 0) return []
    const ids = hotels.map((h) => h.id)
    const gte = new Date(`${win.from}T00:00:00.000Z`)
    const lte = new Date(`${win.to}T00:00:00.000Z`)
    const lteDeparture = new Date(lte.getTime() + 86_400_000)
    const [rooms, plans, mappings, roomMappings, mappedContracts] = await Promise.all([
      tx.roomType.findMany({ where: { hotelId: { in: ids }, hotel: { tenantId } }, select: { id: true, hotelId: true, name: true, code: true, maxAdults: true, maxChildren: true, maxOccupancy: true, isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      tx.ratePlan.findMany({
        where: { tenantId, roomType: { hotelId: { in: ids }, hotel: { tenantId } } },
        select: {
          id: true, code: true, status: true, occupancy: true, currency: true, minStay: true, maxStay: true, releaseDays: true, releaseTimeLocal: true, inventoryPoolId: true, refundable: true, contractId: true, roomTypeId: true, boardBasisId: true,
          boardBasis: { select: { code: true, isActive: true } },
          roomType: { select: { id: true, name: true, code: true, hotelId: true, isActive: true, maxAdults: true, maxChildren: true, maxOccupancy: true, hotel: { select: { contentStatus: true, timeZone: true } } } },
          contract: { select: { id: true, code: true, status: true, validFrom: true, validTo: true, settlementCurrency: true, salesMarkets: true, nationalities: true, supplierId: true, supplierHotelMappingId: true, supplier: { select: { status: true, displayName: true } } } },
          dailyRates: { where: { tenantId, stayDate: { gte, lte } }, select: { stayDate: true, amountMinor: true, currency: true, amountBasis: true, occupancy: true } },
          availability: { where: { tenantId, stayDate: { gte, lte: lteDeparture } }, select: { stayDate: true, allotment: true, sold: true, held: true, stopSell: true, minStay: true, closedToArrival: true, closedToDeparture: true, inventoryMode: true, source: true, freshUntil: true } },
          inventoryPool: { select: { name: true, days: { where: { tenantId, stayDate: { gte, lte } }, select: { stayDate: true, capacity: true, sold: true, held: true, source: true, freshUntil: true } } } },
        },
        orderBy: [{ id: 'asc' }],
      }),
      tx.supplierHotelMapping.findMany({ where: { tenantId, hotelId: { in: ids } }, select: { id: true, supplierId: true, hotelId: true, status: true, supplierHotelId: true, confidence: true, updatedAt: true, supplier: { select: { displayName: true } } }, orderBy: [{ id: 'asc' }] }),
      tx.supplierRoomMapping.findMany({ where: { tenantId, hotelId: { in: ids } }, select: { id: true, supplierHotelMappingId: true, roomTypeId: true, supplierRoomId: true, status: true, confidence: true, updatedAt: true }, orderBy: [{ id: 'asc' }] }),
      tx.contract.findMany({ where: { tenantId, supplierHotelMapping: { is: { hotelId: { in: ids } } } }, select: { id: true, code: true, status: true, validFrom: true, validTo: true, supplierId: true, supplierHotelMappingId: true, supplier: { select: { status: true, displayName: true } }, supplierHotelMapping: { select: { hotelId: true } } } }),
    ])
    const enabledCurrencies = enabledSettlementCurrencies()
    return hotels.map((hotel) => ({
      hotel: { id: hotel.id, name: hotel.name, contentStatus: hotel.contentStatus, starRating: hotel.starRating }, city: hotel.city, enabledCurrencies,
      rooms: rooms.filter((r) => r.hotelId === hotel.id),
      plans: plans.filter((p) => p.roomType.hotelId === hotel.id) as unknown as AuditPlan[],
      contracts: mappedContracts.filter((c) => c.supplierHotelMapping?.hotelId === hotel.id).map((c): AssessContract => ({ id: c.id, code: c.code, status: c.status, validFrom: c.validFrom, validTo: c.validTo, supplierId: c.supplierId, supplierName: c.supplier.displayName, supplierStatus: c.supplier.status, supplierHotelMappingId: c.supplierHotelMappingId })),
      mappings: mappings.filter((m) => m.hotelId === hotel.id).map((m) => ({ id: m.id, supplierId: m.supplierId, supplierName: m.supplier.displayName, hotelId: m.hotelId, status: m.status, supplierHotelId: m.supplierHotelId, confidence: m.confidence, updatedAt: m.updatedAt })),
      roomMappings: roomMappings.filter((m) => rooms.some((r) => r.id === m.roomTypeId && r.hotelId === hotel.id)),
      dates: win.dates, today: this.today(), observedAt: this.clock().toISOString(), markupRules: rules,
    }))
  }

  /** ACTIVE rules for pricing. A denied read is a failure here, never "no rules": a certification must not call NET rates unpriced because a read failed. */
  private async activeRules(tx: Prisma.TransactionClient, tenantId: string) {
    return loadActiveMarkupRulesInTx(tx, tenantId, () => { throw new CommercialControlUnavailableError('markup_rules', 'denied') })
  }

  private async markupAudit(tx: Prisma.TransactionClient, tenantId: string, netPlansWithoutMarkup: number, generatedAt: string): Promise<MarkupRuleAudit> {
    const rows = await tx.commercialMarkupRule.findMany({ where: { tenantId }, select: { id: true, scope: true, supplierId: true, hotelId: true, basisPoints: true, validFrom: true, validTo: true, status: true }, orderBy: [{ id: 'asc' }] })
    const rules = auditMarkupRules(rows.map((r) => ({ ...r, validFrom: day(r.validFrom), validTo: r.validTo ? day(r.validTo) : null })))
    const count = (status: string) => rules.filter((r) => r.status === status).length
    return { generatedAt, rules, counts: { total: rules.length, active: count('ACTIVE'), draft: count('DRAFT'), retired: count('RETIRED'), other: rules.length - count('ACTIVE') - count('DRAFT') - count('RETIRED') }, netPlansWithoutMarkup }
  }

  private async scan(tx: Prisma.TransactionClient, tenantId: string, win: Win, only?: { hotelId: string }): Promise<Scan> {
    const generatedAt = this.clock().toISOString()
    const rules = await this.activeRules(tx, tenantId)
    const where = { tenantId, ...(only ? { id: only.hotelId } : {}) }
    const [hotels, totalHotels] = await Promise.all([
      tx.hotel.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: only ? 1 : L.scanCap, select: HOTEL_SELECT }),
      only ? Promise.resolve(1) : tx.hotel.count({ where }),
    ])
    const inputs = await this.loadInputs(tx, tenantId, hotels, win, rules)
    // Bound the work: hotels are audited in name order until the plan-night budget is spent, and the response says so.
    let budget = this.planNightBudget
    const audits: HotelAudit[] = []
    for (const input of inputs) {
      const cost = input.plans.filter((p) => p.status === 'ACTIVE').length * win.days
      if (audits.length > 0 && cost > budget) break
      budget -= cost
      audits.push(auditHotel(input))
    }
    const plans = audits.flatMap((a) => a.plans)
    const netPlansWithoutMarkup = plans.filter((p) => p.live && p.findings.some((f) => f.code === 'NET_MARKUP_MISSING')).length
    const markup = await this.markupAudit(tx, tenantId, netPlansWithoutMarkup, generatedAt)
    return {
      generatedAt, win, hotels: audits, plans, markup, scanCapped: totalHotels > audits.length, totalHotels,
      remediation: [...remediationItems(plans), ...markupRemediation(markup.rules)].sort((a, b) => REMEDIATION_PRIORITIES.indexOf(a.priority) - REMEDIATION_PRIORITIES.indexOf(b.priority) || a.hotelName.localeCompare(b.hotelName) || a.id.localeCompare(b.id)),
    }
  }

  private window2(scan: Scan) { return { from: scan.win.from, to: scan.win.to, days: scan.win.days } }

  // ---- views -----------------------------------------------------------------------------------------------------------------
  private summarize(scan: Scan): RateCertificationSummary {
    const plans = { PASS: 0, WARN: 0, FAIL: 0 } as Record<CertificationStatus, number>
    const hotels = { NOT_READY: 0, READY_WITH_WARNINGS: 0, CERTIFIED: 0 } as Record<HotelDistributionStatus, number>
    const rowClasses = emptyClasses()
    const findings = new Map<RateFindingCode, { code: RateFindingCode; severity: 'FAIL' | 'WARN' | 'INFO'; plans: number; count: number }>()
    for (const plan of scan.plans) {
      for (const key of Object.keys(rowClasses) as Array<keyof RateRowClassCounts>) rowClasses[key] += plan.rowClasses[key]
      if (!plan.live) continue
      plans[plan.status] += 1
      for (const finding of plan.findings) {
        const entry = findings.get(finding.code) ?? { code: finding.code, severity: finding.severity, plans: 0, count: 0 }
        entry.plans += 1; entry.count += finding.count
        findings.set(finding.code, entry)
      }
    }
    for (const hotel of scan.hotels) hotels[hotel.certification.status] += 1
    const remediation = { P0: 0, P1: 0, P2: 0 } as Record<RemediationPriority, number>
    for (const item of scan.remediation) remediation[item.priority] += 1
    return {
      generatedAt: scan.generatedAt, window: this.window2(scan), scanCapped: scan.scanCapped,
      totals: { hotels: scan.hotels.length, plans: scan.plans.length, livePlans: scan.plans.filter((p) => p.live).length },
      plans, hotels, rowClasses,
      findings: [...findings.values()].sort((a, b) => RATE_FINDING_CODES.indexOf(a.code) - RATE_FINDING_CODES.indexOf(b.code)),
      remediation, markup: { activeRules: scan.markup.counts.active, findings: scan.markup.rules.reduce((n, r) => n + r.findings.length, 0) },
    }
  }

  async summary(tenantId: string, query: Q): Promise<RateCertificationSummary> {
    const win = this.window(query)
    return this.prisma.withTenant(tenantId, async (tx) => this.summarize(await this.scan(tx, tenantId, win)))
  }

  async plans(tenantId: string, query: Q): Promise<RateCertificationPlansPage> {
    const win = this.window(query)
    const page = pageParams(query)
    const status = enumParam('status', query.status, CERTIFICATION_STATUSES)
    const hotelId = idParam('hotelId', query.hotelId)
    const finding = enumParam('finding', query.finding, RATE_FINDING_CODES)
    const live = query.live === undefined || query.live === '' ? undefined : query.live === 'true' ? true : query.live === 'false' ? false : (() => { throw new BadRequestException('Invalid live') })()
    const q = textParam('q', query.q, 64)?.toLowerCase()
    const scan = await this.prisma.withTenant(tenantId, (tx) => this.scan(tx, tenantId, win))
    const filtered = scan.plans.filter((p) =>
      (!status || (p.live && p.status === status)) && (!hotelId || p.hotelId === hotelId) && (live === undefined || p.live === live) &&
      (!finding || p.findings.some((f) => f.code === finding)) && (!q || p.code.toLowerCase().includes(q) || p.hotelName.toLowerCase().includes(q) || p.contractCode.toLowerCase().includes(q)))
    return { generatedAt: scan.generatedAt, window: this.window2(scan), scanCapped: scan.scanCapped, ...paged(filtered.slice(page.skip, page.skip + page.take), page, filtered.length) }
  }

  async plan(tenantId: string, ratePlanIdRaw: string, query: Q): Promise<RatePlanAuditDetail> {
    const ratePlanId = idParam('ratePlanId', ratePlanIdRaw)
    if (!ratePlanId) throw new BadRequestException('Invalid ratePlanId')
    const win = this.window(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const owner = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { roomType: { select: { hotelId: true } } } })
      if (!owner) throw new NotFoundException('Rate plan not found')
      const scan = await this.scan(tx, tenantId, win, { hotelId: owner.roomType.hotelId })
      const hotel = scan.hotels[0]
      const row = hotel?.plans.find((p) => p.ratePlanId === ratePlanId)
      const parts = hotel?.details.get(ratePlanId)
      if (!row || !parts) throw new NotFoundException('Rate plan not found')
      return { ...row, window: this.window2(scan), generatedAt: scan.generatedAt, calendar: parts.calendar, contract: parts.contract }
    })
  }

  async hotels(tenantId: string, query: Q): Promise<HotelCertificationPage> {
    const win = this.window(query)
    const page = pageParams(query)
    const status = enumParam('status', query.status, HOTEL_DISTRIBUTION_STATUSES)
    const q = textParam('q', query.q, 64)?.toLowerCase()
    const scan = await this.prisma.withTenant(tenantId, (tx) => this.scan(tx, tenantId, win))
    const filtered = scan.hotels.map((h) => h.certification).filter((h) => (!status || h.status === status) && (!q || h.hotelName.toLowerCase().includes(q) || h.city.toLowerCase().includes(q)))
    return { generatedAt: scan.generatedAt, window: this.window2(scan), scanCapped: scan.scanCapped, ...paged(filtered.slice(page.skip, page.skip + page.take), page, filtered.length) }
  }

  async markupRules(tenantId: string): Promise<MarkupRuleAudit> {
    const win = this.window({})
    return this.prisma.withTenant(tenantId, async (tx) => (await this.scan(tx, tenantId, win)).markup)
  }

  async remediation(tenantId: string, query: Q): Promise<RemediationQueue> {
    const win = this.window(query)
    const page = pageParams(query)
    const priority = enumParam('priority', query.priority, REMEDIATION_PRIORITIES)
    const hotelId = idParam('hotelId', query.hotelId)
    const scan = await this.prisma.withTenant(tenantId, (tx) => this.scan(tx, tenantId, win))
    const counts = { P0: 0, P1: 0, P2: 0 } as Record<RemediationPriority, number>
    for (const item of scan.remediation) counts[item.priority] += 1
    const filtered = scan.remediation.filter((i) => (!priority || i.priority === priority) && (!hotelId || i.hotelId === hotelId))
    return { generatedAt: scan.generatedAt, scanCapped: scan.scanCapped, counts, ...paged(filtered.slice(page.skip, page.skip + page.take), page, filtered.length) }
  }

  // ---- simulator (read-only) ---------------------------------------------------------------------------------------------------
  async simulate(tenantId: string, body: unknown): Promise<SimulationResult> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('A request body is required')
    const input = body as Partial<SimulateRequest>
    const ratePlanId = idParam('ratePlanId', input.ratePlanId)
    const checkInDate = dayParam('checkIn', input.checkIn); const checkOutDate = dayParam('checkOut', input.checkOut)
    if (!ratePlanId || !checkInDate || !checkOutDate) throw new BadRequestException('ratePlanId, checkIn and checkOut are required')
    const checkIn = day(checkInDate); const checkOut = day(checkOutDate)
    const nights = stayNightCount(checkIn, checkOut)
    if (nights < 1 || nights > L.maxSimulateNights) throw new BadRequestException(`The stay must be 1-${L.maxSimulateNights} nights`)
    const adults = intParam('adults', input.adults, 1, 9); const children = intParam('children', input.children, 0, 9) ?? 0; const rooms = intParam('rooms', input.rooms, 1, 9) ?? 1
    if (adults === undefined) throw new BadRequestException('adults is required')
    const dates = stayDates(checkIn, checkOut)
    const win: Win = { from: checkIn, days: nights, to: dates[dates.length - 1], dates }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const owner = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId }, select: { roomType: { select: { hotelId: true } } } })
      if (!owner) throw new NotFoundException('Rate plan not found')
      const rules = await this.activeRules(tx, tenantId)
      const hotel = await tx.hotel.findFirst({ where: { id: owner.roomType.hotelId, tenantId }, select: HOTEL_SELECT })
      if (!hotel) throw new NotFoundException('Rate plan not found')
      const [loaded] = await this.loadInputs(tx, tenantId, [hotel], win, rules)
      const plan = loaded.plans.find((p) => p.id === ratePlanId)
      if (!plan) throw new NotFoundException('Rate plan not found')
      const { mapping, roomMapping } = mappingFor(plan, loaded)
      const result = simulateStay({ plan, mapping, roomMapping, rules, dates, checkIn, checkOut, adults, children, rooms, now: this.clock() })
      return { ...result, generatedAt: this.clock().toISOString() }
    })
  }

  // ---- report ------------------------------------------------------------------------------------------------------------------
  async report(tenantId: string, query: Q): Promise<RateCertificationReport> {
    const win = this.window(query)
    const format = enumParam('format', query.format, ['json', 'markdown'] as const) ?? 'json'
    const scan = await this.prisma.withTenant(tenantId, (tx) => this.scan(tx, tenantId, win))
    const summary = this.summarize(scan)
    const stamp = scan.generatedAt.slice(0, 10)
    if (format === 'markdown') return { filename: `rate-certification-${stamp}.md`, mediaType: 'text/markdown', generatedAt: scan.generatedAt, content: renderMarkdownReport({ summary, hotels: scan.hotels.map((h) => h.certification), remediation: scan.remediation, markup: scan.markup }) }
    const body = { summary, hotels: scan.hotels.map((h) => h.certification), plans: scan.plans, remediation: scan.remediation, markupRules: scan.markup }
    return { filename: `rate-certification-${stamp}.json`, mediaType: 'application/json', generatedAt: scan.generatedAt, content: JSON.stringify(body, null, 2) }
  }
}

