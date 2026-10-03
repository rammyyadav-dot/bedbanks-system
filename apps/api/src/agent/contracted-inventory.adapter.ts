import { Inject, Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'crypto'
import type { SearchCriteria, SearchHotelOffer, SearchRateOffer } from '@bedbanks/domain'
import type { SupplierType } from '@prisma/client'
import { CACHE_PORT, NoopCache, tenantCacheKey, type CachePort } from '../common/cache/cache.port'
import { PrismaService } from '../database/prisma.service'
import { commercialLeadDays, evaluateContractedStay, stayDates } from '../supply/contracted-sellability'
import { buildStaySnapshot } from '../supply/stay-snapshot'
import { markupResolverFor, type MarkupRuleRow } from '../supply/markup-rules'
import { loadActiveMarkupRules } from '../supply/markup-rules.loader'
import { isRestricted, loadDistributionRestrictions, type DistributionRestrictions } from '../supply/distribution-restrictions'
import { CancellationPolicyService, type CancellationRule } from './cancellation-policy.service'
import { SupplierProviderError, type PrebookRequest, type RecheckedOfferAuthority, type SupplierAdapter, type SupplierRecheckRequest, type SupplierRecheckResult, type SupplierRequestContext, type SupplierSearchContext, type SupplierSearchResult } from './supplier.port'

const OFFER_PREFIX = 'ci_'
const DEFAULT_OFFER_TTL_MS = 900_000
const MIN_OFFER_TTL_MS = 1_000
const MAX_OFFER_TTL_MS = 3_600_000
/** Candidate hotels per rate-plan read. Small enough to keep each query bounded, with no global plan ceiling. */
const HOTEL_CANDIDATE_BATCH = 25

interface StoredOffer {
  offerId: string
  tenantId: string
  supplierId: string
  supplierHotelId: string
  supplierRoomId: string
  canonicalHotelId: string
  canonicalRoomTypeId: string
  ratePlanId: string
  boardBasisId: string
  contractId: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
  currency: string
  expiresAt: string
}

function offerTtlMs(): number {
  const parsed = Number(process.env.AGENT_OFFER_TTL_MS ?? DEFAULT_OFFER_TTL_MS)
  if (!Number.isSafeInteger(parsed)) return DEFAULT_OFFER_TTL_MS
  return Math.min(MAX_OFFER_TTL_MS, Math.max(MIN_OFFER_TTL_MS, parsed))
}

function sourceFor(type: SupplierType): SearchRateOffer['source'] {
  if (type === 'HOTEL_DIRECT') return 'hotel_direct'
  if (type === 'DMC') return 'dmc'
  if (type === 'CHANNEL_MANAGER') return 'channel_manager'
  if (type === 'GDS') return 'gds'
  return 'bedbank'
}

function commercialKey(rate: SearchRateOffer): string {
  return [rate.hotelId, rate.roomTypeId, rate.boardBasisId, rate.ratePlanId, rate.supplierId, rate.contractId ?? ''].join('|')
}

function uniformRoomStays(criteria: SearchCriteria): boolean {
  const stays = criteria.roomStays
  if (!stays || stays.length === 0) return true
  const first = stays[0]
  return stays.every((stay) => stay.adults === first.adults && stay.children.length === first.children.length &&
    stay.children.every((child, index) => child.age === first.children[index].age))
}

function decimalText(value: { toString(): string } | null | undefined): string | undefined {
  if (value == null) return undefined
  const text = value.toString()
  return /^-?\d{1,3}(\.\d{1,6})?$/.test(text) ? text : undefined
}

function storedAddress(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 240 || trimmed !== value.trim()) return undefined
  return trimmed
}

@Injectable()
export class ContractedInventoryAdapter implements SupplierAdapter {
  readonly name = 'contracted-inventory'
  private readonly logger = new Logger(ContractedInventoryAdapter.name)
  private readonly offers = new Map<string, StoredOffer>()
  private readonly cancellation = new CancellationPolicyService()

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_PORT) private readonly cache: CachePort = new NoopCache(),
  ) {}

  async search(criteria: SearchCriteria, context: SupplierSearchContext): Promise<SupplierSearchResult> {
    try {
      const supplierCount = await this.prisma.withTenant(context.tenantId, (tx) => tx.supplier.count({ where: { tenantId: context.tenantId } }))
      if (supplierCount === 0) throw new SupplierProviderError('unconfigured')
      if (!uniformRoomStays(criteria)) return { offers: [], providerSummary: { queried: 1, succeeded: 1, failed: 0 } }
      const nights = stayDates(criteria.checkIn, criteria.checkOut)
      const plans = await this.loadPlans(context.tenantId, criteria, nights)
      const rules = await this.markupRules(context.tenantId)
      const restrictions = await this.restrictionsFor(context.tenantId, context.userId)
      const offers = this.toOffers(plans.filter((plan) => !isRestricted(restrictions, { hotelId: plan.roomType.hotelId, supplierId: plan.contract.supplierId })), criteria, context.tenantId, nights, rules)
      return { offers: await this.withPrimaryImages(context.tenantId, offers), providerSummary: { queried: 1, succeeded: 1, failed: 0 } }
    } catch (error) {
      if (error instanceof SupplierProviderError) throw error
      this.logger.warn(`Contracted inventory search failed requestId=${context.requestId}`)
      throw new SupplierProviderError('transport')
    }
  }

  async recheck(request: SupplierRecheckRequest, context: SupplierRequestContext): Promise<SupplierRecheckResult> {
    try {
      const stored = await this.readOffer(context.tenantId, request.offerId)
      if (!stored) return { status: 'unavailable' }
      if (Date.parse(stored.expiresAt) <= Date.now()) return { status: 'offer_expired' }
      const decision = await this.reprice(context.tenantId, stored, await this.restrictionsFor(context.tenantId, context.userId))
      if (!decision) return { status: 'unavailable' }
      const offer: RecheckedOfferAuthority = {
        offerId: stored.offerId,
        searchId: request.searchId,
        supplierId: stored.supplierId,
        supplierHotelId: stored.supplierHotelId,
        supplierRoomId: stored.supplierRoomId,
        canonicalHotelId: stored.canonicalHotelId,
        canonicalRoomTypeId: stored.canonicalRoomTypeId,
        ratePlanId: stored.ratePlanId,
        boardBasisId: stored.boardBasisId,
        checkIn: stored.checkIn,
        checkOut: stored.checkOut,
        rooms: stored.rooms,
        adults: stored.adults,
        children: stored.children,
        childAges: [...stored.childAges],
        currency: stored.currency,
        sellAmountMinor: decision,
        expiresAt: stored.expiresAt,
      }
      return { status: 'available', offer }
    } catch {
      this.logger.warn(`Contracted inventory recheck failed requestId=${context.requestId}`)
      throw new SupplierProviderError('transport')
    }
  }

  /**
   * In-house contracted inventory is already reserved by the caller's PROCESSING hold, so there is no external
   * supplier to call. Prebook therefore proves the claim instead of re-pricing (re-pricing would count the caller's
   * own hold against the last room): the stored offer must be unexpired and a PROCESSING hold for exactly this
   * offer and search must exist in the tenant.
   */
  async prebook(request: PrebookRequest, context: SupplierRequestContext): Promise<{ supplierReference: string }> {
    const stored = await this.readOffer(context.tenantId, request.offerId)
    if (!stored || Date.parse(stored.expiresAt) <= Date.now()) throw new SupplierProviderError('malformed_response')
    const hold = await this.prisma.withTenant(context.tenantId, tx => tx.inventoryHold.findFirst({
      where: { tenantId: context.tenantId, offerId: request.offerId, searchId: request.searchId, status: 'PROCESSING' }, select: { id: true },
    }))
    if (!hold) throw new SupplierProviderError('malformed_response')
    return { supplierReference: `contracted:${hold.id}` }
  }

  async cancel(): Promise<{ refundMinor: number }> {
    throw new Error('Booking is unavailable until supplier, recheck and finance gates are certified.')
  }

  private async loadPlans(tenantId: string, criteria: SearchCriteria, nights: string[]) {
    const occupancy = criteria.adults + criteria.children
    const checkIn = new Date(`${criteria.checkIn}T00:00:00.000Z`)
    const checkOut = new Date(`${criteria.checkOut}T00:00:00.000Z`)
    const nightDates = nights.map((night) => new Date(`${night}T00:00:00.000Z`))
    const destination = criteria.destination.trim()
    return this.prisma.withTenant(tenantId, async (tx) => {
      const hotels = await tx.hotel.findMany({
        where: {
          tenantId,
          contentStatus: 'COMPLETE',
          ...(criteria.canonicalHotelIds?.length ? { id: { in: criteria.canonicalHotelIds } } : {}),
          ...(criteria.filters?.propertyTypes?.length ? { propertyType: { in: criteria.filters.propertyTypes } } : {}),
          ...(destination ? { city: criteria.destinationRef?.type === 'city' ? { equals: destination, mode: 'insensitive' as const } : { contains: destination, mode: 'insensitive' as const } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      })
      const plans: Awaited<ReturnType<ContractedInventoryAdapter['findPlanBatch']>> = []
      for (let offset = 0; offset < hotels.length; offset += HOTEL_CANDIDATE_BATCH) {
        const hotelIds = hotels.slice(offset, offset + HOTEL_CANDIDATE_BATCH).map((hotel) => hotel.id)
        plans.push(...await this.findPlanBatch(tx, tenantId, criteria, occupancy, checkIn, checkOut, nightDates, hotelIds))
      }
      return plans
    })
  }

  private findPlanBatch(
    tx: Parameters<Parameters<PrismaService['withTenant']>[1]>[0],
    tenantId: string,
    criteria: SearchCriteria,
    occupancy: number,
    checkIn: Date,
    checkOut: Date,
    nightDates: Date[],
    hotelIds: string[],
  ) {
    return tx.ratePlan.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        currency: criteria.currency,
        occupancy,
        boardBasis: { tenantId, isActive: true, ...(criteria.filters?.boardBasisIds ? { id: { in: criteria.filters.boardBasisIds } } : {}) },
        roomType: {
          isActive: true,
          maxAdults: { gte: criteria.adults },
          maxChildren: { gte: criteria.children },
          maxOccupancy: { gte: occupancy },
          hotelId: { in: hotelIds },
          hotel: { tenantId },
        },
        contract: {
          tenantId,
          status: 'ACTIVE',
          settlementCurrency: criteria.currency,
          validFrom: { lte: checkIn },
          validTo: { gte: checkOut },
          supplier: { tenantId, status: 'ACTIVE' },
          supplierHotelMapping: { is: { tenantId, status: 'MAPPED', hotelId: { in: hotelIds } } },
        },
      },
      include: {
        boardBasis: true,
        roomType: { include: { hotel: true } },
        contract: {
          include: {
            supplier: true,
            cancellationPolicies: true,
            supplierHotelMapping: { include: { roomMappings: { where: { tenantId, status: 'MAPPED' } } } },
          },
        },
        dailyRates: { where: { tenantId, occupancy, stayDate: { in: nightDates } } },
        availability: { where: { tenantId, stayDate: { in: nightDates } } },
      },
      orderBy: { id: 'asc' },
    })
  }

  /** ACTIVE markup rules for NET rates. If the database role cannot read them, NET rates stay unsellable and that is logged. */
  private markupRules(tenantId: string): Promise<MarkupRuleRow[]> {
    return loadActiveMarkupRules(this.prisma, tenantId, () => this.logger.warn('Markup rules are not readable by the API database role; NET rates are not sellable'))
  }

  /** Distribution restrictions of the searching user's agency. Unreadable means none, and that is logged. */
  private restrictionsFor(tenantId: string, userId: string | undefined): Promise<DistributionRestrictions> {
    return loadDistributionRestrictions(this.prisma, tenantId, userId, () => this.logger.warn('Distribution restrictions are not readable by the API database role; none are applied'))
  }

  /**
   * Adds each hotel's primary image reference (ADR 0027). Search only returns published hotels, so an image is never attached to a draft.
   * If images cannot be read (for example the runtime role has no grant yet) the hotels are returned without images and a warning is
   * logged: leaving an image out is never misleading, unlike leaving a price out.
   */
  private async withPrimaryImages(tenantId: string, offers: SearchHotelOffer[]): Promise<SearchHotelOffer[]> {
    if (offers.length === 0) return offers
    try {
      const rows = await this.prisma.withTenant(tenantId, (tx) => tx.hotelImage.findMany({
        where: { tenantId, isPrimary: true, hotelId: { in: offers.map((o) => o.hotelId) } },
        select: { id: true, hotelId: true, altText: true, width: true, height: true },
      }))
      const byHotel = new Map(rows.map((r) => [r.hotelId, r]))
      return offers.map((o) => { const r = byHotel.get(o.hotelId); return r ? { ...o, primaryImage: { imageId: r.id, altText: r.altText, width: r.width, height: r.height } } : o })
    } catch (error) {
      this.logger.warn(`Hotel images unreadable; search returned without images (${(error as { code?: string }).code ?? 'unknown'})`)
      return offers
    }
  }

  private toOffers(plans: Awaited<ReturnType<ContractedInventoryAdapter['loadPlans']>>, criteria: SearchCriteria, tenantId: string, nights: string[], rules: readonly MarkupRuleRow[]): SearchHotelOffer[] {
    const expiresAt = new Date(Date.now() + offerTtlMs()).toISOString()
    const leadDays = commercialLeadDays(criteria.checkIn)
    const seen = new Set<string>()
    const priced = plans.flatMap((plan) => {
      const built = this.pricePlan(plan, criteria, tenantId, nights, leadDays, expiresAt, rules)
      if (!built || seen.has(commercialKey(built.rate))) return []
      seen.add(commercialKey(built.rate))
      return [built]
    })
    const byHotel = new Map<string, typeof priced>()
    for (const item of priced) {
      const rows = byHotel.get(item.hotel.hotelId) ?? []
      rows.push(item)
      byHotel.set(item.hotel.hotelId, rows)
    }
    const hotels = [...byHotel.entries()]
      .sort((left, right) => left[1][0].hotel.name.localeCompare(right[1][0].hotel.name) || left[0].localeCompare(right[0]))
      .map(([, items]) => this.hotelOffer(items))
    // The domain validator applies offset and limit once, after this stable order.
    return hotels
  }

  private hotelOffer(items: Array<{ hotel: SearchHotelOffer; rate: SearchRateOffer }>): SearchHotelOffer {
    const bySupplier = new Map<string, typeof items>()
    for (const item of items) {
      const rows = bySupplier.get(item.hotel.supplierId) ?? []
      rows.push(item)
      bySupplier.set(item.hotel.supplierId, rows)
    }
    const [supplierId, chosen] = [...bySupplier.entries()].sort((left, right) => {
      const leftPrice = Math.min(...left[1].map((item) => item.rate.sellAmountMinor))
      const rightPrice = Math.min(...right[1].map((item) => item.rate.sellAmountMinor))
      return leftPrice - rightPrice || left[0].localeCompare(right[0])
    })[0]
    const rooms = new Map<string, SearchHotelOffer['rooms'][number]>()
    const ordered = [...chosen].sort((left, right) => (
      left.hotel.rooms[0].name.localeCompare(right.hotel.rooms[0].name)
      || left.rate.sellAmountMinor - right.rate.sellAmountMinor
      || left.rate.ratePlanId.localeCompare(right.rate.ratePlanId)
    ))
    for (const item of ordered) {
      const room = item.hotel.rooms[0]
      const current = rooms.get(room.roomTypeId)
      if (!current) rooms.set(room.roomTypeId, { ...room, rates: [...room.rates] })
      else current.rates.push(room.rates[0])
    }
    for (const room of rooms.values()) {
      room.rates.sort((left, right) => left.sellAmountMinor - right.sellAmountMinor || left.ratePlanId.localeCompare(right.ratePlanId))
    }
    const hotel = chosen[0].hotel
    return {
      hotelId: hotel.hotelId,
      name: hotel.name,
      destination: hotel.destination,
      starRating: hotel.starRating,
      ...(hotel.propertyType ? { propertyType: hotel.propertyType } : {}),
      ...(hotel.address ? { address: hotel.address } : {}),
      ...(hotel.latitude && hotel.longitude ? { latitude: hotel.latitude, longitude: hotel.longitude } : {}),
      ...(hotel.timeZone ? { timeZone: hotel.timeZone } : {}),
      supplierId,
      supplierHotelId: hotel.supplierHotelId,
      rooms: [...rooms.values()].sort((left, right) => left.name.localeCompare(right.name) || left.roomTypeId.localeCompare(right.roomTypeId)),
    }
  }

  private cancellationSummary(plan: Awaited<ReturnType<ContractedInventoryAdapter['loadPlans']>>[number], checkIn: string): SearchRateOffer['cancellation'] {
    const summary = plan.refundable ? 'Refundable contracted rate' : 'Non-refundable contracted rate'
    const rules: CancellationRule[] = plan.contract.cancellationPolicies.map((rule) => ({
      daysBeforeCheckin: rule.daysBeforeCheckin,
      ...(rule.penaltyPercent != null ? { penaltyPercent: rule.penaltyPercent } : {}),
      ...(rule.penaltyMinor != null ? { penaltyMinor: rule.penaltyMinor } : {}),
      ...(rule.currency ? { currency: rule.currency } : {}),
    }))
    const deadline = this.cancellation.freeCancellationDeadline({ refundable: plan.refundable, checkIn, timeZone: plan.roomType.hotel.timeZone, rules })
    return { refundable: plan.refundable, summary, ...(deadline ? { deadline } : {}) }
  }

  private pricePlan(plan: Awaited<ReturnType<ContractedInventoryAdapter['loadPlans']>>[number], criteria: SearchCriteria, tenantId: string, nights: string[], leadDays: number, expiresAt: string, rules: readonly MarkupRuleRow[], persist = true): { hotel: SearchHotelOffer; rate: SearchRateOffer } | null {
    const mapping = plan.contract.supplierHotelMapping
    const roomMapping = mapping?.roomMappings.find((row) => row.tenantId === tenantId && row.roomTypeId === plan.roomTypeId && row.status === 'MAPPED')
    if (!mapping || !roomMapping || mapping.hotelId !== plan.roomType.hotelId) return null
    const starRating = plan.roomType.hotel.starRating
    if (starRating === null || starRating < 1 || starRating > 5) return null
    if (criteria.filters?.starRatings && !criteria.filters.starRatings.includes(starRating)) return null
    if (criteria.filters?.refundableOnly && !plan.refundable) return null
    const snapshot = buildStaySnapshot(plan, mapping, roomMapping, nights, markupResolverFor(rules, plan.contract.supplierId, plan.roomType.hotelId))
    const decision = evaluateContractedStay(snapshot, {
      checkIn: criteria.checkIn,
      checkOut: criteria.checkOut,
      rooms: criteria.rooms,
      adults: criteria.adults,
      children: criteria.children,
      currency: criteria.currency,
      leadDays,
    })
    if (!decision.eligible || decision.totalMinor === null) return null
    const sellAmountMinor = Number(decision.totalMinor)
    if (criteria.filters?.minPriceMinor !== undefined && sellAmountMinor < criteria.filters.minPriceMinor) return null
    if (criteria.filters?.maxPriceMinor !== undefined && sellAmountMinor > criteria.filters.maxPriceMinor) return null
    const offerId = `${OFFER_PREFIX}${randomUUID()}`
    const stored: StoredOffer = {
      offerId,
      tenantId,
      supplierId: plan.contract.supplierId,
      supplierHotelId: mapping.supplierHotelId,
      supplierRoomId: roomMapping.supplierRoomId,
      canonicalHotelId: plan.roomType.hotelId,
      canonicalRoomTypeId: plan.roomTypeId,
      ratePlanId: plan.id,
      boardBasisId: plan.boardBasisId,
      contractId: plan.contractId,
      checkIn: criteria.checkIn,
      checkOut: criteria.checkOut,
      rooms: criteria.rooms,
      adults: criteria.adults,
      children: criteria.children,
      childAges: [...criteria.childAges],
      currency: criteria.currency,
      expiresAt,
    }
    if (persist) this.remember(stored)
    const remaining = Math.min(...snapshot.nights.map((night) => {
      const row = night.availability
      return row ? row.allotment - row.sold - row.held : 0
    }))
    const rate: SearchRateOffer = {
      offerId,
      tenantId,
      providerId: this.name,
      hotelId: plan.roomType.hotelId,
      canonicalHotelId: plan.roomType.hotelId,
      roomTypeId: plan.roomTypeId,
      canonicalRoomTypeId: plan.roomTypeId,
      supplierId: plan.contract.supplierId,
      supplierRoomId: roomMapping.supplierRoomId,
      ratePlanId: plan.id,
      contractId: plan.contractId,
      ratePlanName: plan.code,
      boardBasisId: plan.boardBasisId,
      boardBasisName: plan.boardBasis.name,
      supplierRateId: plan.id,
      expiresAt,
      occupancy: { rooms: criteria.rooms, adults: criteria.adults, children: criteria.children, childAges: [...criteria.childAges] },
      availability: remaining <= criteria.rooms ? 'limited' : 'available',
      available: true,
      cancellation: this.cancellationSummary(plan, criteria.checkIn),
      total: { amountMinor: sellAmountMinor, currency: criteria.currency },
      netAmountMinor: Number(decision.netMinor ?? decision.totalMinor),
      taxAmountMinor: 0,
      feeAmountMinor: 0,
      totalAmountMinor: Number(decision.netMinor ?? decision.totalMinor), // supplier cost: net plus tax and fees; the offer contract adds markup to reach sell
      markupAmountMinor: Number(decision.markupMinor ?? 0n),
      sellAmountMinor,
      paymentType: 'prepaid',
      source: sourceFor(plan.contract.supplier.type),
    }
    const latitude = decimalText(plan.roomType.hotel.latitude)
    const longitude = decimalText(plan.roomType.hotel.longitude)
    const address = storedAddress(plan.roomType.hotel.address)
    const hotel: SearchHotelOffer = {
      hotelId: plan.roomType.hotelId,
      name: plan.roomType.hotel.name,
      destination: plan.roomType.hotel.city,
      starRating,
      ...(plan.roomType.hotel.propertyType ? { propertyType: plan.roomType.hotel.propertyType } : {}),
      ...(address ? { address } : {}),
      ...(latitude && longitude ? { latitude, longitude } : {}),
      ...(plan.roomType.hotel.timeZone ? { timeZone: plan.roomType.hotel.timeZone } : {}),
      supplierId: plan.contract.supplierId,
      supplierHotelId: mapping.supplierHotelId,
      rooms: [{ roomTypeId: plan.roomTypeId, name: plan.roomType.name, supplierRoomId: roomMapping.supplierRoomId, rates: [rate] }],
    }
    return { hotel, rate }
  }

  private async reprice(tenantId: string, stored: StoredOffer, restrictions: DistributionRestrictions): Promise<number | null> {
    const criteria: SearchCriteria = {
      destination: '',
      canonicalHotelIds: [stored.canonicalHotelId],
      checkIn: stored.checkIn,
      checkOut: stored.checkOut,
      rooms: stored.rooms,
      adults: stored.adults,
      children: stored.children,
      childAges: [...stored.childAges],
      nationality: 'AE',
      currency: stored.currency,
    }
    const nights = stayDates(stored.checkIn, stored.checkOut)
    const plans = await this.loadPlans(tenantId, criteria, nights)
    const rules = await this.markupRules(tenantId)
    const plan = plans.find((candidate) => candidate.id === stored.ratePlanId && candidate.contractId === stored.contractId)
    if (!plan || isRestricted(restrictions, { hotelId: plan.roomType.hotelId, supplierId: plan.contract.supplierId })) return null
    const priced = this.pricePlan(plan, { ...criteria, destination: plan.roomType.hotel.city }, tenantId, nights, commercialLeadDays(stored.checkIn), stored.expiresAt, rules, false)
    if (!priced || priced.rate.ratePlanId !== stored.ratePlanId || priced.rate.supplierRoomId !== stored.supplierRoomId) return null
    return priced.rate.sellAmountMinor
  }

  private remember(offer: StoredOffer): void {
    this.offers.set(this.offerKey(offer.tenantId, offer.offerId), offer)
    const ttlMs = Math.max(MIN_OFFER_TTL_MS, Date.parse(offer.expiresAt) - Date.now())
    void this.cache.set(tenantCacheKey(offer.tenantId, 'contracted-offer', offer.offerId), offer, { ttlMs }).catch(() => undefined)
  }

  private async readOffer(tenantId: string, offerId: string): Promise<StoredOffer | null> {
    const key = this.offerKey(tenantId, offerId)
    const local = this.offers.get(key)
    if (local) return local
    try {
      return await this.cache.get<StoredOffer>(tenantCacheKey(tenantId, 'contracted-offer', offerId))
    } catch {
      return null
    }
  }

  private offerKey(tenantId: string, offerId: string): string {
    return `${tenantId}:${offerId}`
  }
}
