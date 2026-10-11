import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import {
  COMMERCIAL_ISSUE_CATEGORIES, COMMERCIAL_WINDOW_DEFAULT_DAYS, COMMERCIAL_WINDOW_MAX_DAYS, CONTRACT_EXPIRING_DAYS, CONTRACT_EXPIRY_FILTER_DAYS,
  type AuditEventView, type CalendarCell, type CalendarRow, type CommercialIssue, type ExceptionsPage,
  type DistributionBlocker, type DistributionCoverageRow, type HotelCalendar, type HotelCommercial360, type HotelDistribution, type HotelCommercialPage, type HotelRowProfile, type HotelCommercialRow, type HotelCommercialSummary, type HotelContractRow,
  type HotelContractsView, type HotelMappingsView, type HotelRatePlanRow, type IssueSeverity, type NightVerdict, type Paged,
  type MarkupImpact, type MarketDestinationRow, type MarketsSummary, type RoomCommercialRow, type SellabilityInspection, type SellabilityPlanResult,
  type InventoryMode, type HotelCompleteness, type HotelContacts, type HotelReadinessAssessment,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { bookingEnabled } from '../agent/booking-transaction.service'
import { isBookingReadDenied } from '../admin-dashboard/admin-dashboard.service'
import { rowIsFresh, evaluateContractedStay, stayDates, stayNightCount } from '../supply/contracted-sellability'
import { CommercialControlUnavailableError, controlReadFailure } from '../supply/commercial-controls'
import { buildHotelStayReadiness } from './hotel-stay-readiness'
import { buildStaySnapshot, nightStock } from '../supply/stay-snapshot'
import { markupResolverFor, resolveMarkupBasisPoints } from '../supply/markup-rules'
import { markupMinor } from '@bedbanks/pricing'
import { loadActiveMarkupRulesInTx } from '../supply/markup-rules.loader'
import {
  assessHotel, contractStateOf, evaluatePlanNight, gateResults, mappingFor, windowDates,
  type AssessContract, type AssessHotelInput, type AssessPlan, type HotelAssessment,
} from '../supply/commercial-assessment'
import { loadPrimaryImages, loadProfileSummaries } from '../hotel-setup/hotel-profile-summary'
import { assessCompleteness } from '../hotel-setup/hotel-setup-rules'
import { assessReadiness, type AgencyEvidence } from '../supply/hotel-readiness'
import { normalizeCountry } from '../supply/market-rules'
import { assertSupportedSettlementCurrency, defaultSettlementCurrency } from '../agent/currency'
import { auditView } from './operations-transactions.service'
import { day, guardedRead, iso, sectionRead } from './operations-read'
import { dayParam, enumParam, idParam, intParam, likeLiteral, pageParams, paged, textParam } from './query-params'

const stringList = (value: Prisma.JsonValue): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 40).slice(0, 100) : [])

/** Only a short `source` string is surfaced from stored source metadata, which may hold raw supplier payloads. */
const provenanceOf = (metadata: Prisma.JsonValue): string | null => {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).source : undefined
  return typeof source === 'string' && source.length > 0 && source.length <= 80 && !/[\u0000-\u001f]/.test(source) ? source : null
}

/** The most hotels a computed filter, summary or exception scan will assess in one request. Responses say when it was reached. */
export const COMMERCIAL_SCAN_CAP = 500
const CONTENT_STATUSES = ['DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED', 'ARCHIVED'] as const
const STARS = ['1', '2', '3', '4', '5', 'UNRATED'] as const
const READINESS = ['READY', 'PARTIAL', 'BLOCKED'] as const
const MAPPING = ['MAPPED', 'PENDING', 'REJECTED', 'NONE'] as const
const CONTRACT_STATES = ['ACTIVE', 'EXPIRING', 'EXPIRED', 'INACTIVE', 'NONE'] as const
const SEVERITIES = ['CRITICAL', 'HIGH', 'WARNING'] as const
const CALENDAR_MAX_DAYS = 62
const CALENDAR_MAX_PLANS = 100
const INSPECT_MAX_NIGHTS = 31
const ISSUE_FILTER = /^[A-Z][A-Z_]{2,47}$/
const AUDIT_ENTITY_LIMIT = 2000
/** Entity types the hotel audit view can be narrowed to (the mapping history view uses the first two). */
const AUDIT_ENTITY_TYPES = ['supplier_hotel_mapping', 'supplier_room_mapping', 'hotel', 'room_type', 'contract', 'rate_plan'] as const

type Win = { from: string; days: number; to: string; dates: string[] }
type HotelRecord = { id: string; name: string; externalRef: string | null; city: string; countryCode: string; starRating: number | null; propertyType: string; contentStatus: string; timeZone: string; address: string | null; latitude: Prisma.Decimal | null; longitude: Prisma.Decimal | null; updatedAt: Date }

/** Read-only hotel commercial views. Every readiness, gate, issue and reason comes from the shared canonical assessor. */
@Injectable()
export class OperationsHotelsService {
  /** Replaceable in tests so date-dependent behaviour is deterministic. */
  clock: () => Date = () => new Date()

  constructor(private readonly prisma: PrismaService) {}

  private today(): string { return this.clock().toISOString().slice(0, 10) }

  private window(query: Record<string, unknown>, defaultDays = COMMERCIAL_WINDOW_DEFAULT_DAYS, maxDays = COMMERCIAL_WINDOW_MAX_DAYS): Win {
    const fromDate = dayParam('from', query.from)
    const from = fromDate ? day(fromDate) : this.today()
    const days = intParam('days', query.days, 1, maxDays) ?? defaultDays
    const dates = windowDates(from, days)
    return { from, days, to: dates[dates.length - 1], dates }
  }

  // ---- loading (bulk: a fixed number of queries regardless of hotel count) -----------------------------------------------
  private async loadInputs(tx: Prisma.TransactionClient, tenantId: string, hotels: HotelRecord[], win: Win): Promise<Map<string, AssessHotelInput>> {
    const markupRules = await loadActiveMarkupRulesInTx(tx, tenantId)
    const out = new Map<string, AssessHotelInput>()
    if (hotels.length === 0) return out
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
          // One day past the window: the departure row of the last night carries closedToDeparture.
          availability: { where: { tenantId, stayDate: { gte, lte: lteDeparture } }, select: { stayDate: true, allotment: true, sold: true, held: true, stopSell: true, minStay: true, closedToArrival: true, closedToDeparture: true, inventoryMode: true, source: true, freshUntil: true } },
          inventoryPool: { select: { name: true, days: { where: { tenantId, stayDate: { gte, lte } }, select: { stayDate: true, capacity: true, sold: true, held: true, source: true, freshUntil: true } } } },
        },
        orderBy: [{ id: 'asc' }],
      }),
      tx.supplierHotelMapping.findMany({ where: { tenantId, hotelId: { in: ids } }, select: { id: true, supplierId: true, hotelId: true, status: true, supplierHotelId: true, confidence: true, updatedAt: true, supplier: { select: { displayName: true } } }, orderBy: [{ id: 'asc' }] }),
      tx.supplierRoomMapping.findMany({ where: { tenantId, hotelId: { in: ids } }, select: { id: true, supplierHotelMappingId: true, roomTypeId: true, supplierRoomId: true, status: true, confidence: true, updatedAt: true }, orderBy: [{ id: 'asc' }] }),
      tx.contract.findMany({ where: { tenantId, supplierHotelMapping: { is: { hotelId: { in: ids } } } }, select: { id: true, code: true, status: true, validFrom: true, validTo: true, supplierId: true, supplierHotelMappingId: true, supplier: { select: { status: true, displayName: true } }, supplierHotelMapping: { select: { hotelId: true } } } }),
    ])
    for (const hotel of hotels) {
      out.set(hotel.id, {
        hotel: { id: hotel.id, name: hotel.name, contentStatus: hotel.contentStatus, starRating: hotel.starRating },
        rooms: rooms.filter((r) => r.hotelId === hotel.id),
        plans: plans.filter((p) => p.roomType.hotelId === hotel.id) as unknown as AssessPlan[],
        contracts: mappedContracts.filter((c) => c.supplierHotelMapping?.hotelId === hotel.id).map((c): AssessContract => ({ id: c.id, code: c.code, status: c.status, validFrom: c.validFrom, validTo: c.validTo, supplierId: c.supplierId, supplierName: c.supplier.displayName, supplierStatus: c.supplier.status, supplierHotelMappingId: c.supplierHotelMappingId })),
        mappings: mappings.filter((m) => m.hotelId === hotel.id).map((m) => ({ id: m.id, supplierId: m.supplierId, supplierName: m.supplier.displayName, hotelId: m.hotelId, status: m.status, supplierHotelId: m.supplierHotelId, confidence: m.confidence, updatedAt: m.updatedAt })),
        roomMappings: roomMappings.filter((m) => rooms.some((r) => r.id === m.roomTypeId && r.hotelId === hotel.id)),
        dates: win.dates, today: this.today(), observedAt: this.clock().toISOString(), markupRules,
      })
    }
    return out
  }

  private async assessAll(tx: Prisma.TransactionClient, tenantId: string, hotels: HotelRecord[], win: Win): Promise<Map<string, HotelAssessment>> {
    const inputs = await this.loadInputs(tx, tenantId, hotels, win)
    return new Map([...inputs.entries()].map(([id, input]) => [id, assessHotel(input)]))
  }

  private async hotelRecord(tx: Prisma.TransactionClient, tenantId: string, hotelIdRaw: string): Promise<HotelRecord> {
    const hotelId = idParam('hotelId', hotelIdRaw)
    if (!hotelId) throw new BadRequestException('Invalid hotelId')
    const hotel = await tx.hotel.findFirst({ where: { id: hotelId, tenantId }, select: HOTEL_SELECT })
    if (!hotel) throw new NotFoundException('Hotel not found')
    return hotel
  }

  private row(hotel: HotelRecord, a: HotelAssessment, extra: { profile: HotelRowProfile | null; verifiedMappings: number; primaryImage: { imageId: string; altText: string } | null }): HotelCommercialRow {
    const count = (s: IssueSeverity) => a.issues.filter((i) => i.severity === s).length
    return {
      id: hotel.id, name: hotel.name, code: hotel.externalRef, city: hotel.city, countryCode: hotel.countryCode, starRating: hotel.starRating, propertyType: hotel.propertyType, contentStatus: hotel.contentStatus,
      suppliers: a.suppliers, contractState: a.contractState, contractDaysToExpiry: a.contractDaysToExpiry, hotelMapping: a.hotelMapping,
      rooms: a.roomCounts, ratePlans: a.planCounts, rates: a.rates, inventory: a.inventory, readiness: a.readiness, blockers: a.blockers,
      issues: { total: a.issues.length, critical: count('CRITICAL'), high: count('HIGH'), warning: count('WARNING') }, updatedAt: hotel.updatedAt.toISOString(),
      verifiedMappings: extra.verifiedMappings, profile: extra.profile, primaryImage: extra.primaryImage,
    }
  }

  private async rowExtras(tx: Prisma.TransactionClient, tenantId: string, hotels: HotelRecord[], assessed: Map<string, HotelAssessment>) {
    const active = new Map(hotels.map((h) => [h.id, assessed.get(h.id)!.roomCounts.active]))
    const { profiles, verifiedMappings } = await loadProfileSummaries(tx, tenantId, hotels, active)
    const images = await loadPrimaryImages(tx, tenantId, hotels.map((h) => h.id)) // sequential: each guarded read owns its SAVEPOINT
    return { available: profiles !== null, for: (id: string) => ({ profile: profiles?.get(id) ?? null, verifiedMappings: verifiedMappings.get(id) ?? 0, primaryImage: images?.get(id) ?? null }) }
  }

  // ---- list ----------------------------------------------------------------------------------------------------------------
  private baseWhere(tenantId: string, query: Record<string, unknown>) {
    const search = textParam('search', query.search, 64)
    const destination = textParam('destination', query.destination, 64)
    const contentStatus = enumParam('contentStatus', query.contentStatus, CONTENT_STATUSES)
    const supplierId = idParam('supplierId', query.supplierId)
    const mapping = enumParam('mapping', query.mapping, MAPPING)
    const propertyType = textParam('propertyType', query.propertyType, 32)
    if (propertyType !== undefined && !/^[A-Z][A-Z_]{1,31}$/.test(propertyType)) throw new BadRequestException('Invalid propertyType')
    const stars = enumParam('stars', query.stars, STARS)
    const and: Prisma.HotelWhereInput[] = []
    // Name, the legacy code, the canonical id (exact) or an external identifier such as a GIATA id.
    if (search) and.push({ OR: [{ name: { contains: likeLiteral(search), mode: 'insensitive' } }, { externalRef: { startsWith: likeLiteral(search), mode: 'insensitive' } }, { id: search }, { externalIdentifiers: { some: { value: { startsWith: likeLiteral(search), mode: 'insensitive' } } } }] })
    if (propertyType) and.push({ propertyType })
    if (stars === 'UNRATED') and.push({ starRating: null })
    else if (stars) and.push({ starRating: Number(stars) })
    if (supplierId) and.push({ OR: [{ mappings: { some: { supplierId } } }, { roomTypes: { some: { ratePlans: { some: { contract: { supplierId } } } } } }] })
    if (mapping === 'NONE') and.push({ mappings: { none: {} } })
    else if (mapping) and.push({ mappings: { some: { status: mapping } } })
    const where: Prisma.HotelWhereInput = { tenantId, ...(destination && { city: { equals: destination, mode: 'insensitive' } }), ...(contentStatus && { contentStatus }), ...(and.length && { AND: and }) }
    return where
  }

  private computedFilters(query: Record<string, unknown>) {
    const readiness = enumParam('readiness', query.readiness, READINESS)
    const contractState = enumParam('contractState', query.contractState, CONTRACT_STATES)
    const issueRaw = query.issue
    if (issueRaw !== undefined && issueRaw !== '' && (typeof issueRaw !== 'string' || !ISSUE_FILTER.test(issueRaw))) throw new BadRequestException('Invalid issue')
    const issue = issueRaw === undefined || issueRaw === '' ? undefined : (issueRaw as string)
    const expires = intParam('expiresWithinDays', query.expiresWithinDays, 1, 365)
    if (expires !== undefined && !(CONTRACT_EXPIRY_FILTER_DAYS as readonly number[]).includes(expires)) throw new BadRequestException('Invalid expiresWithinDays')
    return { readiness, contractState, issue, expires, any: Boolean(readiness || contractState || issue || expires) }
  }

  async list(tenantId: string, query: Record<string, unknown>): Promise<HotelCommercialPage> {
    const page = pageParams(query)
    const win = this.window(query)
    const where = this.baseWhere(tenantId, query)
    const f = this.computedFilters(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const destinations = (await tx.hotel.findMany({ where: { tenantId }, distinct: ['city'], select: { city: true }, orderBy: { city: 'asc' }, take: 200 })).map((h) => h.city)
      const order: Prisma.HotelOrderByWithRelationInput[] = [{ name: 'asc' }, { id: 'asc' }]
      if (!f.any) {
        const [hotels, total] = await Promise.all([tx.hotel.findMany({ where, orderBy: order, skip: page.skip, take: page.take, select: HOTEL_SELECT }), tx.hotel.count({ where })])
        const assessed = await this.assessAll(tx, tenantId, hotels, win)
        const extras = await this.rowExtras(tx, tenantId, hotels, assessed)
        return { ...paged(hotels.map((h) => this.row(h, assessed.get(h.id)!, extras.for(h.id))), page, total), profilesAvailable: extras.available, window: { from: win.from, to: win.to, days: win.days }, scanCapped: false, destinations }
      }
      // Computed filters need the assessment, so a bounded set is assessed first and then paged. The response says when the cap is hit.
      const candidates = await tx.hotel.findMany({ where, orderBy: order, take: COMMERCIAL_SCAN_CAP + 1, select: HOTEL_SELECT })
      const scanCapped = candidates.length > COMMERCIAL_SCAN_CAP
      const scanned = candidates.slice(0, COMMERCIAL_SCAN_CAP)
      const assessed = await this.assessAll(tx, tenantId, scanned, win)
      const kept = scanned.filter((h) => {
        const a = assessed.get(h.id)!
        if (f.readiness && a.readiness !== f.readiness) return false
        if (f.contractState && a.contractState !== f.contractState) return false
        if (f.issue && !a.issues.some((i) => i.category === f.issue || i.reason === f.issue)) return false
        if (f.expires !== undefined && !(a.contractDaysToExpiry !== null && a.contractDaysToExpiry >= 0 && a.contractDaysToExpiry <= f.expires)) return false
        return true
      })
      const slice = kept.slice(page.skip, page.skip + page.take)
      const extras = await this.rowExtras(tx, tenantId, slice, assessed)
      return { ...paged(slice.map((h) => this.row(h, assessed.get(h.id)!, extras.for(h.id))), page, kept.length), profilesAvailable: extras.available, window: { from: win.from, to: win.to, days: win.days }, scanCapped, destinations }
    })
  }

  // ---- summary -------------------------------------------------------------------------------------------------------------
  /** What the active markup rules do to ACTIVE rate plans over the window: priced, unpriced and stored-sell plan-nights, per currency. Bounded by the scan cap. */
  async markupImpact(tenantId: string, query: Record<string, unknown>): Promise<MarkupImpact> {
    const win = this.window(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const total = await tx.hotel.count({ where: { tenantId } })
      const hotels = await tx.hotel.findMany({ where: { tenantId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: COMMERCIAL_SCAN_CAP, select: HOTEL_SELECT })
      const inputs = await this.loadInputs(tx, tenantId, hotels, win)
      const counts = { sell: 0, netPriced: 0, netUnpriced: 0, basisUnverified: 0 }
      const money = new Map<string, { net: bigint; markup: bigint }>()
      const affected: Array<{ hotelId: string; hotelName: string; unpricedNights: number }> = []
      for (const input of inputs.values()) {
        let unpriced = 0
        for (const plan of input.plans.filter((p) => p.status === 'ACTIVE')) {
          const rates = new Map(plan.dailyRates.filter((r) => r.occupancy === plan.occupancy).map((r) => [day(r.stayDate), r]))
          for (const date of input.dates) {
            const rate = rates.get(date)
            if (!rate || rate.amountMinor < 0n || rate.currency !== plan.currency) continue // a missing or invalid rate is a rate gap, reported elsewhere
            if (rate.amountBasis === 'SELL') counts.sell += 1
            else if (rate.amountBasis !== 'NET') counts.basisUnverified += 1
            else {
              const bp = resolveMarkupBasisPoints(input.markupRules ?? [], { supplierId: plan.contract.supplierId, hotelId: plan.roomType.hotelId }, date)
              if (bp === null) { counts.netUnpriced += 1; unpriced += 1 }
              else {
                counts.netPriced += 1
                const m = money.get(rate.currency) ?? { net: 0n, markup: 0n }
                m.net += rate.amountMinor; m.markup += markupMinor(rate.amountMinor, bp)
                money.set(rate.currency, m)
              }
            }
          }
        }
        if (unpriced > 0) affected.push({ hotelId: input.hotel.id, hotelName: input.hotel.name, unpricedNights: unpriced })
      }
      affected.sort((a, b) => b.unpricedNights - a.unpricedNights || a.hotelName.localeCompare(b.hotelName))
      return {
        generatedAt: this.clock().toISOString(), window: { from: win.from, to: win.to, days: win.days }, scanCapped: total > COMMERCIAL_SCAN_CAP, totalHotels: total,
        planNights: counts, affectedHotels: affected.slice(0, 10), affectedHotelCount: affected.length,
        currencies: [...money.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, m]) => ({ currency, netMinor: m.net.toString(), markupMinor: m.markup.toString() })),
        definitions: {
          planNights: 'One ACTIVE rate plan on one night of the window, counted with the plan\'s own occupancy. Plan-nights with no rate, an invalid rate or a currency mismatch are rate gaps and are not counted here.',
          netUnpriced: 'A NET rate with no ACTIVE markup rule in force for that night. It is not sellable until a rule applies.',
          basisUnverified: 'A rate whose amount basis is not recorded as NET or SELL. It is not sellable, and no markup rule can change that.',
          currencies: 'Supplier cost and markup for priced NET plan-nights, summed per currency. Currencies are never added together.',
          scope: `Computed over at most ${COMMERCIAL_SCAN_CAP} hotels (alphabetical); scanCapped says when the tenant has more.`,
        },
      }
    })
  }

  /** Hotel supply and sellability grouped by destination, from the same assessment as the hotel list (bounded by the scan cap). */
  async markets(tenantId: string, query: Record<string, unknown>): Promise<MarketsSummary> {
    const win = this.window(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const total = await tx.hotel.count({ where: { tenantId } })
      const hotels = await tx.hotel.findMany({ where: { tenantId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: COMMERCIAL_SCAN_CAP, select: HOTEL_SELECT })
      const assessed = await this.assessAll(tx, tenantId, hotels, win)
      const groups = new Map<string, MarketDestinationRow>()
      for (const h of hotels) {
        const a = assessed.get(h.id)
        if (!a) continue
        const city = (h.city ?? '').trim() || 'Unspecified'
        const key = `${h.countryCode}|${city.toLowerCase()}`
        const g = groups.get(key) ?? { countryCode: h.countryCode, city, hotels: 0, ready: 0, partial: 0, blocked: 0, mappingIssues: 0, rateGaps: 0, availabilityGaps: 0, contractsExpiring: 0 }
        g.hotels += 1
        if (a.readiness === 'READY') g.ready += 1; else if (a.readiness === 'PARTIAL') g.partial += 1; else g.blocked += 1
        if (a.hotelMapping !== 'MAPPED' || a.roomCounts.mapped < a.roomCounts.active) g.mappingIssues += 1
        if (a.rates === 'GAPS') g.rateGaps += 1
        if (a.inventory === 'GAPS') g.availabilityGaps += 1
        if (a.contractState === 'EXPIRING') g.contractsExpiring += 1
        groups.set(key, g)
      }
      return {
        generatedAt: this.clock().toISOString(), window: { from: win.from, to: win.to, days: win.days }, scanCapped: total > COMMERCIAL_SCAN_CAP, totalHotels: total,
        destinations: [...groups.values()].sort((x, y) => y.hotels - x.hotels || x.city.localeCompare(y.city)),
        definitions: {
          destination: 'A hotel belongs to the destination named by its country code and city. Geography groups supply; it is never a tenant boundary.',
          readiness: 'READY, PARTIAL and BLOCKED are the Agent-search evaluator verdicts over the window, as on the hotel list.',
          scope: `Computed over at most ${COMMERCIAL_SCAN_CAP} hotels (alphabetical); scanCapped says when the tenant has more.`,
        },
      }
    })
  }

  async summary(tenantId: string, query: Record<string, unknown>): Promise<HotelCommercialSummary> {
    const win = this.window(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const total = await tx.hotel.count({ where: { tenantId } })
      const hotels = await tx.hotel.findMany({ where: { tenantId }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: COMMERCIAL_SCAN_CAP, select: HOTEL_SELECT })
      const assessed = [...(await this.assessAll(tx, tenantId, hotels, win)).values()]
      const count = (predicate: (a: HotelAssessment) => boolean) => assessed.filter(predicate).length
      return {
        generatedAt: this.clock().toISOString(), window: { from: win.from, to: win.to, days: win.days }, scanCapped: total > COMMERCIAL_SCAN_CAP, totalHotels: total,
        readiness: { ready: count((a) => a.readiness === 'READY'), partial: count((a) => a.readiness === 'PARTIAL'), blocked: count((a) => a.readiness === 'BLOCKED') },
        mappingIssueHotels: count((a) => a.hotelMapping !== 'MAPPED' || a.roomCounts.mapped < a.roomCounts.active),
        rateGapHotels: count((a) => a.rates === 'GAPS'), availabilityGapHotels: count((a) => a.inventory === 'GAPS'), stopSellHotels: count((a) => a.plans.some((p) => p.counts.stopSell > 0)),
        contractsExpiring: count((a) => a.contractState === 'EXPIRING'), contractsExpired: count((a) => a.contractState === 'EXPIRED'), contractExpiringDays: CONTRACT_EXPIRING_DAYS,
        definitions: {
          readiness: 'READY: every active rate plan is sellable on every night of the window. PARTIAL: some plan-nights are sellable and some are not. BLOCKED: no plan-night is sellable, or no rate plan is active. Each plan-night is judged by the Agent\'s own evaluator (evaluateContractedStay) for a one-night stay; min/max stay and release days are stay rules and appear in the Sellability Inspector.',
          mappingIssueHotels: 'Hotels with no approved supplier hotel mapping, or with active rooms that have no approved room mapping.',
          rateGapHotels: 'Hotels where an active rate plan has a night in the window with no valid daily rate.',
          availabilityGapHotels: 'Hotels where an active rate plan has a night in the window with no availability row.',
          stopSellHotels: 'Hotels where an active rate plan has a night in the window on stop-sell.',
          contractsExpiring: `Hotels whose best contract is ACTIVE and ends within ${CONTRACT_EXPIRING_DAYS} days.`,
          contractsExpired: 'Hotels whose contracts have all ended or are marked EXPIRED.',
          scope: `Computed over at most ${COMMERCIAL_SCAN_CAP} hotels (alphabetical); scanCapped says when the tenant has more.`,
        },
      }
    })
  }

  // ---- hotel 360 -----------------------------------------------------------------------------------------------------------
  async detail(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<HotelCommercial360> {
    const win = this.window(query)
    const core = await this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const a = (await this.assessAll(tx, tenantId, [hotel], win)).get(hotel.id)!
      return { hotel, a }
    })
    const { hotel, a } = core
    // Counts come from tables the API role may not read; they are fetched separately so a denial never breaks the page.
    const bookings = await sectionRead(() => this.prisma.withTenant(tenantId, (tx) => tx.booking.count({ where: { tenantId, hotelId: hotel.id } })))
    const holds = await sectionRead(() => this.prisma.withTenant(tenantId, (tx) => tx.inventoryHold.count({ where: { tenantId, canonicalHotelId: hotel.id, status: { in: ['HELD', 'PROCESSING', 'HOLD_PENDING'] } } })))
    const rooms: RoomCommercialRow[] = a.rooms.map((r) => ({
      id: r.room.id, name: r.room.name, code: r.room.code, maxAdults: r.room.maxAdults, maxChildren: r.room.maxChildren, maxOccupancy: r.room.maxOccupancy, isActive: r.room.isActive,
      mapping: r.mapping, supplierRoomIds: r.supplierRoomIds, ratePlans: { total: a.plans.filter((p) => p.plan.roomTypeId === r.room.id).length, active: r.activePlans }, inventory: r.inventory, readiness: r.readiness, blockers: r.blockers,
    }))
    return {
      generatedAt: this.clock().toISOString(), window: { from: win.from, to: win.to, days: win.days },
      hotel: { id: hotel.id, name: hotel.name, code: hotel.externalRef, city: hotel.city, countryCode: hotel.countryCode, starRating: hotel.starRating, propertyType: hotel.propertyType, contentStatus: hotel.contentStatus, timeZone: hotel.timeZone, address: hotel.address, updatedAt: hotel.updatedAt.toISOString() },
      suppliers: a.suppliers, readiness: a.readiness, agentSellable: a.agentSellable, blockers: a.blockers, gates: a.gates, rooms, issues: a.issues,
      counts: { bookings: bookings.state === 'available' ? bookings.data : null, activeHolds: holds.state === 'available' ? holds.data : null },
      contractState: a.contractState, hotelMapping: a.hotelMapping,
    }
  }

  // ---- mappings ------------------------------------------------------------------------------------------------------------
  async mappings(tenantId: string, hotelIdRaw: string): Promise<HotelMappingsView> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const [hotelMappings, roomMappings, rooms] = await Promise.all([
        tx.supplierHotelMapping.findMany({ where: { tenantId, hotelId: hotel.id }, include: { supplier: { select: { displayName: true } } }, orderBy: [{ id: 'asc' }] }),
        tx.supplierRoomMapping.findMany({ where: { tenantId, hotelId: hotel.id }, include: { roomType: { select: { name: true } } }, orderBy: [{ id: 'asc' }] }),
        tx.roomType.findMany({ where: { hotelId: hotel.id, hotel: { tenantId }, isActive: true }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      ])
      const unmapped = hotelMappings.flatMap((m) => rooms.filter((r) => !roomMappings.some((rm) => rm.supplierHotelMappingId === m.id && rm.roomTypeId === r.id && rm.status === 'MAPPED')).map((r) => ({ roomTypeId: r.id, roomName: r.name, hotelMappingId: m.id, supplierName: m.supplier.displayName })))
      return {
        hotelMappings: hotelMappings.map((m) => ({ id: m.id, supplierId: m.supplierId, supplierName: m.supplier.displayName, supplierHotelId: m.supplierHotelId, status: m.status, confidence: m.confidence, provenance: provenanceOf(m.sourceMetadata), createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString() })),
        roomMappings: roomMappings.map((m) => ({ id: m.id, hotelMappingId: m.supplierHotelMappingId, roomTypeId: m.roomTypeId, roomName: m.roomType.name, supplierRoomId: m.supplierRoomId, status: m.status, confidence: m.confidence, provenance: provenanceOf(m.sourceMetadata), createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString() })),
        unmappedRooms: unmapped,
      }
    })
  }

  // ---- contracts and rate plans --------------------------------------------------------------------------------------------
  async contracts(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<HotelContractsView> {
    const win = this.window(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const input = (await this.loadInputs(tx, tenantId, [hotel], win)).get(hotel.id)!
      const a = assessHotel(input)
      const contractIds = new Set<string>([...input.contracts.map((c) => c.id), ...input.plans.map((p) => p.contract.id)])
      const rows = await tx.contract.findMany({
        where: { tenantId, id: { in: [...contractIds] } },
        select: { id: true, code: true, status: true, validFrom: true, validTo: true, settlementCurrency: true, salesMarkets: true, nationalities: true, version: true, updatedAt: true, supplierId: true, supplierHotelMappingId: true, supplier: { select: { displayName: true } } },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      })
      const viaMapping = new Set(input.contracts.map((c) => c.id))
      const policyCounts = await this.policyCounts(tenantId, rows.map((c) => c.id))
      const contracts: HotelContractRow[] = rows.map((c) => {
        const { state, daysToExpiry } = contractStateOf(c, input.today)
        const plans = input.plans.filter((p) => p.contract.id === c.id)
        return {
          id: c.id, code: c.code, supplierId: c.supplierId, supplierName: c.supplier.displayName, status: c.status, state, validFrom: day(c.validFrom), validTo: day(c.validTo), daysToExpiry, currency: c.settlementCurrency, version: c.version, updatedAt: c.updatedAt.toISOString(),
          ratePlans: { total: plans.length, active: plans.filter((p) => p.status === 'ACTIVE').length },
          policies: policyCounts ? (policyCounts.get(c.id) ?? { cancellation: 0, child: 0, leadTime: 0 }) : null,
          link: viaMapping.has(c.id) ? 'MAPPING' : 'RATE_PLAN', mappingId: c.supplierHotelMappingId, salesMarkets: stringList(c.salesMarkets), nationalities: stringList(c.nationalities),
        }
      })
      const assessedById = new Map(a.plans.map((p) => [p.plan.id, p]))
      const ratePlans: HotelRatePlanRow[] = [...input.plans].sort((x, y) => x.roomType.name.localeCompare(y.roomType.name) || x.code.localeCompare(y.code) || x.id.localeCompare(y.id)).map((p) => {
        const s = assessedById.get(p.id)
        return {
          id: p.id, code: p.code, status: p.status, contractId: p.contract.id, contractCode: p.contract.code, roomTypeId: p.roomTypeId, roomName: p.roomType.name, boardBasisId: p.boardBasisId, boardCode: p.boardBasis.code.trim(), boardActive: p.boardBasis.isActive,
          occupancy: p.occupancy, currency: p.currency, refundable: p.refundable, minStay: p.minStay, maxStay: p.maxStay, releaseDays: p.releaseDays,
          window: s ? s.counts : { nights: 0, sellable: 0, rateMissing: 0, availabilityMissing: 0, stopSell: 0, exhausted: 0, blockedOther: 0 },
          amountBasis: s ? s.amountBasis : 'NONE', readiness: s ? s.readiness : 'BLOCKED',
        }
      })
      return { contracts, ratePlans, expiringDays: CONTRACT_EXPIRING_DAYS }
    })
  }

  /**
   * Policy tables are not readable by every runtime role. They are read in their own transactions so that a privilege denial
   * (42501) leaves the rest of the contracts view intact and is reported as null, not as zero.
   */
  private async policyCounts(tenantId: string, contractIds: string[]): Promise<Map<string, { cancellation: number; child: number; leadTime: number }> | null> {
    if (contractIds.length === 0) return new Map()
    const read = await sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const where = { contractId: { in: contractIds } }
      const [cancellation, child, leadTime] = await Promise.all([
        tx.cancellationPolicy.groupBy({ by: ['contractId'], where, _count: { _all: true } }),
        tx.childPolicy.groupBy({ by: ['contractId'], where, _count: { _all: true } }),
        tx.bookingLeadTimeRule.groupBy({ by: ['contractId'], where, _count: { _all: true } }),
      ])
      const out = new Map<string, { cancellation: number; child: number; leadTime: number }>()
      const bump = (rows: Array<{ contractId: string; _count: { _all: number } }>, key: 'cancellation' | 'child' | 'leadTime') => { for (const r of rows) out.set(r.contractId, { ...(out.get(r.contractId) ?? { cancellation: 0, child: 0, leadTime: 0 }), [key]: r._count._all }) }
      bump(cancellation, 'cancellation'); bump(child, 'child'); bump(leadTime, 'leadTime')
      return out
    }))
    return read.state === 'available' ? read.data : null
  }

  // ---- rate & inventory calendar -------------------------------------------------------------------------------------------
  async calendar(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<HotelCalendar> {
    const win = this.window(query, 14, CALENDAR_MAX_DAYS)
    const roomTypeId = idParam('roomTypeId', query.roomTypeId)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const input = (await this.loadInputs(tx, tenantId, [hotel], win)).get(hotel.id)!
      const all = input.plans.filter((p) => !roomTypeId || p.roomTypeId === roomTypeId).sort((x, y) => x.roomType.name.localeCompare(y.roomType.name) || x.code.localeCompare(y.code) || x.id.localeCompare(y.id))
      const plans = all.slice(0, CALENDAR_MAX_PLANS)
      // Fields the shared stay snapshot does not carry: closed-to-departure and the source freshness stamps. Read in one bounded query per table.
      const planIds = plans.map((p) => p.id); const gte = new Date(`${win.dates[0]}T00:00:00.000Z`); const lte = new Date(`${win.dates[win.dates.length - 1]}T00:00:00.000Z`)
      const [extraAvail, extraRates] = planIds.length === 0 ? [[], []] : await Promise.all([
        tx.dailyAvailability.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte, lte } }, select: { ratePlanId: true, stayDate: true, closedToDeparture: true, sourceUpdatedAt: true } }),
        tx.dailyRate.findMany({ where: { tenantId, ratePlanId: { in: planIds }, stayDate: { gte, lte } }, select: { ratePlanId: true, stayDate: true, occupancy: true, sourceUpdatedAt: true } }),
      ])
      const availExtra = new Map(extraAvail.map((r) => [`${r.ratePlanId}:${day(r.stayDate)}`, r])); const rateExtra = new Map(extraRates.map((r) => [`${r.ratePlanId}:${day(r.stayDate)}:${r.occupancy}`, r]))
      const rows: CalendarRow[] = plans.map((plan) => {
        const { mapping, roomMapping } = mappingFor(plan, input)
        const rates = new Map(plan.dailyRates.filter((r) => r.occupancy === plan.occupancy).map((r) => [day(r.stayDate), r]))
        const avail = new Map(plan.availability.map((r) => [day(r.stayDate), r]))
        const cells: CalendarCell[] = win.dates.map((date) => {
          const rate = rates.get(date); const row = avail.get(date)
          const reasons = evaluatePlanNight(plan, mapping, roomMapping, date, input.hotel.starRating, undefined, input.markupRules, this.clock())
          return {
            date, rateMinor: rate ? rate.amountMinor.toString() : null, currency: rate ? rate.currency : null, amountBasis: rate?.amountBasis === 'SELL' || rate?.amountBasis === 'NET' ? rate.amountBasis : null,
            allotment: row?.allotment ?? null, sold: row?.sold ?? null, held: row?.held ?? null, remaining: nightStock(plan, date).remaining,
            inventoryMode: row ? toInventoryMode(row.inventoryMode) : null, stockSource: row ? (toInventoryMode(row.inventoryMode) !== 'ALLOTMENT' ? 'NONE' : plan.inventoryPoolId ? 'POOL' : 'PLAN_ROW') : null, poolId: plan.inventoryPoolId ?? null,
            ...poolCells(plan, date),
            source: row?.source ?? null, freshUntil: iso(row?.freshUntil), stale: row ? !rowIsFresh(row.source ?? 'ADMIN', row.freshUntil ? row.freshUntil.toISOString() : null, this.clock()) : false,
            stopSell: row ? row.stopSell : null, closedToArrival: row ? row.closedToArrival : null, minStay: row ? row.minStay : null, sellable: reasons.length === 0, reasons,
            closedToDeparture: row ? row.closedToDeparture ?? false : null,
            rateSourceUpdatedAt: iso(rateExtra.get(`${plan.id}:${date}:${plan.occupancy}`)?.sourceUpdatedAt), availabilitySourceUpdatedAt: iso(availExtra.get(`${plan.id}:${date}`)?.sourceUpdatedAt),
          }
        })
        return { ratePlanId: plan.id, ratePlanCode: plan.code, planStatus: plan.status, roomTypeId: plan.roomTypeId, roomName: plan.roomType.name, boardCode: plan.boardBasis.code.trim(), currency: plan.currency, occupancy: plan.occupancy, contractCode: plan.contract.code, supplierName: plan.contract.supplier.displayName, cells }
      })
      return { hotelId: hotel.id, window: { from: win.from, to: win.to, days: win.days }, rows, truncated: all.length > plans.length }
    })
  }

  // ---- distribution and readiness ------------------------------------------------------------------------------------------
  /** Catalogue publication, transaction enablement and a seven-day coverage assessment from the same evaluator Agent search uses. Read-only. */
  async distribution(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<HotelDistribution> {
    const calendar = await this.calendar(tenantId, hotelIdRaw, { ...query, days: 7, roomTypeId: undefined })
    const { hotel, restrictions } = await this.prisma.withTenant(tenantId, async (tx) => {
      const record = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const suppliers = (await tx.supplierHotelMapping.findMany({ where: { tenantId, hotelId: record.id }, select: { supplierId: true } })).map((m) => m.supplierId)
      await tx.$executeRawUnsafe('SAVEPOINT distribution_restrictions_read')
      try {
        const [hotelScoped, supplierScoped] = await Promise.all([
          tx.distributionRestriction.count({ where: { tenantId, status: 'ACTIVE', scope: 'HOTEL', hotelId: record.id } }),
          suppliers.length ? tx.distributionRestriction.count({ where: { tenantId, status: 'ACTIVE', scope: 'SUPPLIER', supplierId: { in: suppliers } } }) : Promise.resolve(0),
        ])
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT distribution_restrictions_read')
        return { hotel: record, restrictions: { hotel: hotelScoped, supplier: supplierScoped } as HotelDistribution['restrictions'] }
      } catch (error) {
        if (!isBookingReadDenied(error)) throw error
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT distribution_restrictions_read')
        return { hotel: record, restrictions: null as HotelDistribution['restrictions'] }
      }
    })
    const published = hotel.contentStatus === 'COMPLETE'; const suspended = hotel.contentStatus === 'SUSPENDED'; const starOk = hotel.starRating !== null && hotel.starRating >= 1 && hotel.starRating <= 5
    const reasons = [...(published ? [] : [suspended ? 'HOTEL_SUSPENDED' : 'HOTEL_NOT_PUBLISHED']), ...(starOk ? [] : ['HOTEL_STAR_RATING_MISSING'])]
    const blockers = new Map<string, { nights: number; dates: Set<string>; rooms: Set<string>; plans: Set<string>; suppliers: Set<string> }>()
    const byRoom = new Map<string, DistributionCoverageRow>(); const bySupplier = new Map<string, DistributionCoverageRow>()
    let sellable = 0; let planNights = 0
    for (const row of calendar.rows) {
      const room = byRoom.get(row.roomName) ?? { label: row.roomName, planNights: 0, sellable: 0 }; const sup = bySupplier.get(row.supplierName) ?? { label: row.supplierName, planNights: 0, sellable: 0 }
      for (const cell of row.cells) {
        planNights++; room.planNights++; sup.planNights++
        if (cell.sellable) { sellable++; room.sellable++; sup.sellable++; continue }
        for (const reason of cell.reasons) {
          const b = blockers.get(reason) ?? { nights: 0, dates: new Set(), rooms: new Set(), plans: new Set(), suppliers: new Set() }
          b.nights++; b.dates.add(cell.date); b.rooms.add(row.roomName); b.plans.add(row.ratePlanCode); b.suppliers.add(row.supplierName); blockers.set(reason, b)
        }
      }
      byRoom.set(row.roomName, room); bySupplier.set(row.supplierName, sup)
    }
    const list: DistributionBlocker[] = [...blockers.entries()].map(([reason, b]) => ({ reason, nights: b.nights, dates: [...b.dates].sort(), rooms: [...b.rooms].sort().slice(0, 50), ratePlans: [...b.plans].sort().slice(0, 50), suppliers: [...b.suppliers].sort().slice(0, 50) })).sort((a, b) => b.nights - a.nights || a.reason.localeCompare(b.reason))
    return {
      generatedAt: new Date().toISOString(), hotelId: hotel.id,
      catalogue: { status: hotel.contentStatus, published, suspended, starRatingValid: starOk, eligible: published && starOk, reasons },
      transaction: { bookingEnabled: bookingEnabled() },
      // Agent search lists only published, rated hotels, so a night being sellable is not enough on its own.
      restrictions, agentSellable: published && starOk && sellable > 0,
      coverage: { window: calendar.window, planNights, sellableNights: sellable, byRoom: [...byRoom.values()], bySupplier: [...bySupplier.values()], truncated: calendar.truncated },
      blockers: list,
    }
  }

  // ---- sellability inspector (stay level) ----------------------------------------------------------------------------------
  async sellability(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>, userId?: string): Promise<SellabilityInspection> {
    const checkInDate = dayParam('checkIn', query.checkIn); const checkOutDate = dayParam('checkOut', query.checkOut)
    if (!checkInDate || !checkOutDate) throw new BadRequestException('checkIn and checkOut are required')
    const checkIn = day(checkInDate); const checkOut = day(checkOutDate)
    const nights = stayNightCount(checkIn, checkOut)
    if (nights < 1 || nights > INSPECT_MAX_NIGHTS) throw new BadRequestException(`The stay must be 1-${INSPECT_MAX_NIGHTS} nights`)
    if (checkIn < this.today()) throw new BadRequestException('Check-in must not be in the past')
    const adults = intParam('adults', query.adults, 1, 9); const children = intParam('children', query.children, 0, 9) ?? 0; const rooms = intParam('rooms', query.rooms, 1, 9) ?? 1
    if (adults === undefined) throw new BadRequestException('adults is required')
    const roomTypeId = idParam('roomTypeId', query.roomTypeId)
    const agencyId = idParam('agencyId', query.agencyId)
    const nationality = textParam('nationality', query.nationality, 2)?.toUpperCase() ?? null
    if (nationality && !/^[A-Z]{2}$/.test(nationality)) throw new BadRequestException('Invalid nationality')
    const currency = enumParam('currency', query.currency, ['AED'] as const) ?? null
    const dates = stayDates(checkIn, checkOut)
    const win: Win = { from: checkIn, days: nights, to: dates[dates.length - 1], dates }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const input = (await this.loadInputs(tx, tenantId, [hotel], win)).get(hotel.id)!
      let market: string | null = null
      let agencyStatus: string | null = null
      let restrictions: Array<{ scope: string; hotelId: string | null; supplierId: string | null }> = []
      if (agencyId) {
        await this.requireAgencyRead(tx, tenantId, userId)
        let agency: { status: string; countryCode: string | null } | null
        try {
          agency = await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { status: true, countryCode: true } })
          restrictions = await tx.distributionRestriction.findMany({ where: { tenantId, agencyId, status: 'ACTIVE' }, select: { scope: true, hotelId: true, supplierId: true } })
        } catch (error) { throw controlReadFailure('distribution_restrictions', error) }
        if (!agency) throw new NotFoundException('Agency not found')
        if (restrictions.some(r => r.scope === 'HOTEL' ? !r.hotelId : r.scope === 'SUPPLIER' ? !r.supplierId : true)) throw new CommercialControlUnavailableError('distribution_restrictions', 'malformed')
        market = agency.countryCode?.trim().toUpperCase() ?? null
        agencyStatus = agency.status
      }
      const now = this.clock()
      const results: SellabilityPlanResult[] = []
      for (const plan of input.plans.filter((p) => !roomTypeId || p.roomTypeId === roomTypeId).sort((x, y) => x.roomType.name.localeCompare(y.roomType.name) || x.code.localeCompare(y.code) || x.id.localeCompare(y.id))) {
        const { mapping, roomMapping } = mappingFor(plan, input)
        const ownRates = { ...plan, dailyRates: plan.dailyRates.filter((r) => r.occupancy === plan.occupancy) }
        const decision = evaluateContractedStay(buildStaySnapshot(ownRates, mapping, roomMapping, dates, markupResolverFor(input.markupRules ?? [], plan.contract.supplierId, plan.roomType.hotelId)), { checkIn, checkOut, rooms, adults, children, currency: currency ?? plan.currency, now, ...(agencyId ? { buyer: { market, nationality } } : {}) })
        const reasons = [...decision.reasons]
        if (agencyId && agencyStatus === 'SUSPENDED') reasons.push('AGENCY_SUSPENDED')
        if (agencyId && restrictions.some(r => r.scope === 'HOTEL' ? r.hotelId === hotel.id : r.supplierId === plan.contract.supplierId)) reasons.push('DISTRIBUTION_RESTRICTED')
        if (!(input.hotel.starRating !== null && input.hotel.starRating >= 1 && input.hotel.starRating <= 5)) reasons.push('HOTEL_STAR_RATING_MISSING')
        const ratesByDate = new Map(ownRates.dailyRates.map((r) => [day(r.stayDate), r]))
        const nightVerdicts: NightVerdict[] = dates.map((date) => {
          const nightReasons = evaluatePlanNight(plan, mapping, roomMapping, date, input.hotel.starRating, { adults, children, rooms }, input.markupRules, now)
          const rate = ratesByDate.get(date)
          return { date, sellable: nightReasons.length === 0, reasons: nightReasons, rateMinor: rate ? rate.amountMinor.toString() : null, remaining: nightStock(plan, date).remaining }
        })
        const sellable = reasons.length === 0 && decision.eligible
        results.push({
          contractId: plan.contract.id, supplierId: plan.contract.supplierId, ratePlanId: plan.id, ratePlanCode: plan.code, roomTypeId: plan.roomTypeId, roomName: plan.roomType.name, boardCode: plan.boardBasis.code.trim(), contractCode: plan.contract.code, supplierName: plan.contract.supplier.displayName,
          sellable, reasons, gates: gateResults(reasons), nights: nightVerdicts, totalMinor: sellable && decision.totalMinor !== null ? decision.totalMinor.toString() : null, currency: plan.currency,
        })
      }
      const sellablePlans = results.filter((r) => r.sellable)
      const hotelReasons = [...new Set([...(hotel.contentStatus !== 'COMPLETE' ? ['HOTEL_INACTIVE'] : []), ...(input.plans.length === 0 ? ['RATE_PLAN_MISSING'] : [])])]
      const currencies = new Set(sellablePlans.map((r) => r.currency))
      const totals = sellablePlans.filter((r) => r.totalMinor !== null).map((r) => BigInt(r.totalMinor as string))
      const cheapest = currencies.size === 1 && totals.length > 0 ? totals.reduce((m, v) => (v < m ? v : m)) : null
      const readiness = buildHotelStayReadiness(hotel.id, results, now.toISOString(), { agencyId: agencyId ?? null, market, nationality, currency, children })
      return {
        readiness,
        hotelId: hotel.id, hotelName: hotel.name, request: { checkIn, checkOut, adults, children, rooms, nights, roomTypeId: roomTypeId ?? null, agencyId: agencyId ?? null, market, nationality, currency },
        sellable: sellablePlans.length > 0, hotelReasons, offers: sellablePlans.length, cheapestMinor: cheapest === null ? null : cheapest.toString(), currency: cheapest === null ? null : [...currencies][0], plans: results, evaluatedAt: now.toISOString(),
      }
    })
  }


  /** Naming an agency exposes agency data, so it needs the existing tenant-scoped `agency.read` on top of the route permission. Fails closed. */
  private async requireAgencyRead(tx: Prisma.TransactionClient, tenantId: string, userId: string | undefined): Promise<void> {
    if (!userId) throw new ForbiddenException('Access denied')
    const assignments = await tx.userRole.findMany({ where: { tenantId, userId, role: { tenantId } }, select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } } })
    if (!assignments.some((a) => a.role.permissions.some((p) => p.permission.key === 'agency.read'))) throw new ForbiddenException('Access denied')
  }

  // ---- unified readiness (explicit criteria) -------------------------------------------------------------------------------
  /**
   * Seven separate gates for one explicit stay, occupancy, nationality, agency and currency. Commercial verdicts come from the shared evaluator;
   * unreadable evidence (a privilege boundary) is reported UNKNOWN, never FAIL, zero or empty. Read-only: nothing is allocated or written.
   */
  async readiness(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>, userId?: string): Promise<HotelReadinessAssessment> {
    const checkInDate = dayParam('checkIn', query.checkIn); const checkOutDate = dayParam('checkOut', query.checkOut)
    if (!checkInDate || !checkOutDate) throw new BadRequestException('checkIn and checkOut are required')
    const checkIn = day(checkInDate); const checkOut = day(checkOutDate)
    const nights = stayNightCount(checkIn, checkOut)
    if (nights < 1 || nights > INSPECT_MAX_NIGHTS) throw new BadRequestException(`The stay must be 1-${INSPECT_MAX_NIGHTS} nights`)
    if (checkIn < this.today()) throw new BadRequestException('Check-in must not be in the past')
    const adults = intParam('adults', query.adults, 1, 9); const children = intParam('children', query.children, 0, 9) ?? 0; const rooms = intParam('rooms', query.rooms, 1, 9) ?? 1
    if (adults === undefined) throw new BadRequestException('adults is required')
    const childAges = (typeof query.childAges === 'string' && query.childAges.length > 0 ? query.childAges.split(',') : []).map((age) => (/^\d{1,2}$/.test(age.trim()) ? Number(age) : NaN))
    if (childAges.length !== children || childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 17)) throw new BadRequestException('childAges must list one age (0-17) for each child')
    const nationalityRaw = textParam('nationality', query.nationality, 2)
    const nationality = nationalityRaw === undefined ? null : normalizeCountry(nationalityRaw)
    if (nationalityRaw !== undefined && nationality === null) throw new BadRequestException('nationality must be a two-letter ISO country code')
    const currency = textParam('currency', query.currency, 3)?.toUpperCase() ?? defaultSettlementCurrency()
    assertSupportedSettlementCurrency(currency)
    const agencyId = idParam('agencyId', query.agencyId) ?? null
    const dates = stayDates(checkIn, checkOut)
    const win: Win = { from: checkIn, days: nights, to: dates[dates.length - 1], dates }
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const assess = (await this.loadInputs(tx, tenantId, [hotel], win)).get(hotel.id)!
      const content = await this.readCompleteness(tx, tenantId, hotel)
      let agency: AgencyEvidence | null | 'UNREADABLE' = null
      let market: string | null = null
      if (agencyId) {
        await this.requireAgencyRead(tx, tenantId, userId)
        const row = await tx.agency.findFirst({ where: { id: agencyId, tenantId }, select: { id: true, name: true, status: true, countryCode: true } })
        if (!row) throw new NotFoundException('Agency not found')
        market = normalizeCountry(row.countryCode)
        agency = await this.readAgencyRestrictions(tx, tenantId, row, hotel.id)
      }
      const supplierNames = new Map(assess.plans.map((p) => [p.contract.supplierId, p.contract.supplier.displayName]))
      return assessReadiness({ criteria: { checkIn, checkOut, nights, rooms, adults, children, childAges, nationality, agencyId, market, currency }, now: this.clock(), assess, content, agency, supplierNames })
    })
  }

  /** Profile completeness behind a SAVEPOINT: a denied read is `null` (UNKNOWN), any other error propagates as an infrastructure failure. */
  private async readCompleteness(tx: Prisma.TransactionClient, tenantId: string, hotel: HotelRecord): Promise<HotelCompleteness | null> {
    await tx.$executeRawUnsafe('SAVEPOINT readiness_profile_read')
    try {
      const [profile, activeRooms] = await Promise.all([tx.hotelProfile.findFirst({ where: { hotelId: hotel.id, tenantId } }), tx.roomType.count({ where: { hotelId: hotel.id, isActive: true } })])
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT readiness_profile_read')
      const dec = (d: Prisma.Decimal | null) => (d === null ? null : d.toFixed(6).replace(/\.?0+$/, '') || '0')
      return assessCompleteness({
        name: hotel.name, propertyType: hotel.propertyType, countryCode: hotel.countryCode, city: hotel.city, address: hotel.address, latitude: dec(hotel.latitude), longitude: dec(hotel.longitude), timeZone: hotel.timeZone,
        starRating: hotel.starRating, starVerified: Boolean(profile?.starVerifiedAt), shortDescription: profile?.shortDescription ?? null, checkInTime: profile?.checkInTime ?? null, checkOutTime: profile?.checkOutTime ?? null,
        contacts: (profile?.contacts && typeof profile.contacts === 'object' && !Array.isArray(profile.contacts) ? profile.contacts : {}) as HotelContacts, activeRooms,
      })
    } catch (error) {
      if (!isBookingReadDenied(error)) throw error
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT readiness_profile_read')
      return null
    }
  }

  /** The agency's ACTIVE distribution restrictions. Unreadable, or a restriction that names no target, is 'UNREADABLE': it never means unrestricted (ADR 0031). */
  private async readAgencyRestrictions(tx: Prisma.TransactionClient, tenantId: string, agency: { id: string; name: string; status: string }, hotelId: string): Promise<AgencyEvidence | 'UNREADABLE'> {
    await tx.$executeRawUnsafe('SAVEPOINT readiness_agency_read')
    try {
      const rows = await tx.distributionRestriction.findMany({ where: { tenantId, agencyId: agency.id, status: 'ACTIVE' }, select: { scope: true, hotelId: true, supplierId: true } })
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT readiness_agency_read')
      if (rows.some((r) => !((r.scope === 'HOTEL' && r.hotelId) || (r.scope === 'SUPPLIER' && r.supplierId)))) return 'UNREADABLE'
      return { id: agency.id, name: agency.name, status: agency.status, hotelRestricted: rows.some((r) => r.scope === 'HOTEL' && r.hotelId === hotelId), restrictedSupplierIds: rows.filter((r) => r.scope === 'SUPPLIER').map((r) => r.supplierId as string) }
    } catch (error) {
      if (!isBookingReadDenied(error)) throw error
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT readiness_agency_read')
      return 'UNREADABLE'
    }
  }

  // ---- audit ---------------------------------------------------------------------------------------------------------------
  async audit(tenantId: string, hotelIdRaw: string, query: Record<string, unknown>): Promise<Paged<AuditEventView>> {
    const page = pageParams(query)
    // AuditEvent is not readable by every runtime role: a denial is reported as OPERATIONS_READ_DENIED, never as an empty list or a 500.
    return guardedRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const hotel = await this.hotelRecord(tx, tenantId, hotelIdRaw)
      const [rooms, plans, contracts, mappings, roomMappings] = await Promise.all([
        tx.roomType.findMany({ where: { hotelId: hotel.id, hotel: { tenantId } }, select: { id: true } }),
        tx.ratePlan.findMany({ where: { tenantId, roomType: { hotelId: hotel.id } }, select: { id: true, contractId: true } }),
        tx.contract.findMany({ where: { tenantId, OR: [{ supplierHotelMapping: { is: { hotelId: hotel.id } } }, { ratePlans: { some: { roomType: { hotelId: hotel.id } } } }] }, select: { id: true } }),
        tx.supplierHotelMapping.findMany({ where: { tenantId, hotelId: hotel.id }, select: { id: true } }),
        tx.supplierRoomMapping.findMany({ where: { tenantId, hotelId: hotel.id }, select: { id: true } }),
      ])
      const ids = [...new Set([hotel.id, ...rooms.map((r) => r.id), ...plans.map((p) => p.id), ...contracts.map((c) => c.id), ...mappings.map((m) => m.id), ...roomMappings.map((m) => m.id)])].slice(0, AUDIT_ENTITY_LIMIT)
      const entityType = enumParam('entityType', query.entityType, AUDIT_ENTITY_TYPES)
      const where: Prisma.AuditEventWhereInput = { tenantId, entityId: { in: ids }, ...(entityType && { entityType }) }
      const [rows, total] = await Promise.all([
        tx.auditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: page.skip, take: page.take }),
        tx.auditEvent.count({ where }),
      ])
      return paged(rows.map(auditView), page, total)
    }))
  }

  // ---- exceptions ----------------------------------------------------------------------------------------------------------
  async exceptions(tenantId: string, query: Record<string, unknown>): Promise<ExceptionsPage> {
    const page = pageParams(query)
    const win = this.window(query)
    const severity = enumParam('severity', query.severity, SEVERITIES)
    const category = enumParam('category', query.category, COMMERCIAL_ISSUE_CATEGORIES)
    const supplierId = idParam('supplierId', query.supplierId)
    const hotelId = idParam('hotelId', query.hotelId)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const where: Prisma.HotelWhereInput = { tenantId, ...(hotelId && { id: hotelId }) }
      const candidates = await tx.hotel.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: COMMERCIAL_SCAN_CAP + 1, select: HOTEL_SELECT })
      const scanCapped = candidates.length > COMMERCIAL_SCAN_CAP
      const hotels = candidates.slice(0, COMMERCIAL_SCAN_CAP)
      const assessed = await this.assessAll(tx, tenantId, hotels, win)
      let issues: CommercialIssue[] = [...assessed.values()].flatMap((a) => a.issues)
      if (category) issues = issues.filter((i) => i.category === category)
      if (supplierId) issues = issues.filter((i) => i.supplierId === supplierId)
      const counts: Record<IssueSeverity, number> = { CRITICAL: 0, HIGH: 0, WARNING: 0 }
      for (const issue of issues) counts[issue.severity] += 1
      if (severity) issues = issues.filter((i) => i.severity === severity)
      const rank: Record<IssueSeverity, number> = { CRITICAL: 0, HIGH: 1, WARNING: 2 }
      issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.hotelName.localeCompare(b.hotelName) || a.id.localeCompare(b.id))
      return { ...paged(issues.slice(page.skip, page.skip + page.take), page, issues.length), scanCapped, window: { from: win.from, to: win.to, days: win.days }, counts }
    })
  }
}

const toInventoryMode = (value: string | undefined): InventoryMode => (value === 'ALLOTMENT' || value === 'FREE_SALE' || value === 'ON_REQUEST' || value === 'CLOSED' ? value : value === undefined ? 'ALLOTMENT' : 'CLOSED')

/** The pool's name and this night's authoritative stock for a pooled plan; nulls for a plan with its own stock. */
function poolCells(plan: { inventoryPoolId?: string | null; inventoryPool?: { name?: string; days: Array<{ stayDate: Date; capacity: number; sold: number; held: number }> } | null }, date: string) {
  const d = plan.inventoryPoolId ? plan.inventoryPool?.days.find((x) => day(x.stayDate) === date) : undefined
  return { poolName: plan.inventoryPoolId ? plan.inventoryPool?.name ?? null : null, poolCapacity: d?.capacity ?? null, poolSold: d?.sold ?? null, poolHeld: d?.held ?? null }
}

const HOTEL_SELECT = { id: true, name: true, externalRef: true, city: true, countryCode: true, starRating: true, propertyType: true, contentStatus: true, timeZone: true, address: true, latitude: true, longitude: true, updatedAt: true } as const
