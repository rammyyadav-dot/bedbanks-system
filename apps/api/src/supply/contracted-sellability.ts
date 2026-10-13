import { markupMinor, MAX_MARKUP_BASIS_POINTS } from '@bedbanks/pricing'
import { releaseAllows } from './zoned-time'
import { hotelToday } from './rate-plan-expiry'
import { selectPromotion, type AppliedPromotion, type PromotionRule } from './promotions'
import { resolveGuestPricing, type GuestPriceLine } from './guest-pricing'
import { marketReasons, planMarketReasons, type BuyerContext, type ContractMarketRules } from './market-rules'
/**
 * Shared commercial gates for contracted inventory.
 * The single-night helper preserves the existing admin sellability reasons.
 * Stay evaluation is what Agent Search and recheck use for a full date range.
 */

const NIGHT_MS = 86_400_000

export interface NightSellabilityPlan {
  status: string
  occupancy: number
  currency: string
  /** ADR 0057 sale window; null inherits the contract term. Required so a caller cannot omit it. */
  validFrom: Date | null
  validTo: Date | null
  roomType: { isActive: boolean; maxOccupancy: number; hotelId: string; hotel: { contentStatus: string } }
  boardBasis: { isActive: boolean }
  contract: {
    status: string
    validFrom: Date
    validTo: Date
    supplier: { status: string }
    supplierHotelMapping: { hotelId: string; status: string } | null
  }
  dailyRates: Array<{ amountMinor: bigint; currency: string; amountBasis: string | null }>
  availability: Array<{ stopSell: boolean; allotment: number; sold: number; held: number }>
}

export function evaluateNightSellability(plan: NightSellabilityPlan | null, input: { stayDate: Date; occupancy: number }): string[] {
  const reasons: string[] = []
  if (!plan) {
    reasons.push('RATE_PLAN_MISSING')
    return reasons
  }
  if (['SUSPENDED', 'ARCHIVED'].includes(plan.roomType.hotel.contentStatus)) reasons.push('HOTEL_INACTIVE')
  if (!plan.roomType.isActive) reasons.push('ROOM_TYPE_INACTIVE')
  if (!plan.boardBasis.isActive) reasons.push('BOARD_BASIS_INACTIVE')
  if (plan.contract.supplier.status !== 'ACTIVE') reasons.push('SUPPLIER_INACTIVE')
  if (input.occupancy !== plan.occupancy || input.occupancy > plan.roomType.maxOccupancy) reasons.push('OCCUPANCY_UNSUPPORTED')
  if (plan.contract.status !== 'ACTIVE') reasons.push('CONTRACT_INACTIVE')
  if (input.stayDate < plan.contract.validFrom || input.stayDate > plan.contract.validTo) reasons.push('OUTSIDE_CONTRACT_VALIDITY')
  if ((plan.validFrom && input.stayDate < plan.validFrom) || (plan.validTo && input.stayDate > plan.validTo)) reasons.push('OUTSIDE_RATE_PLAN_VALIDITY')
  if (plan.contract.supplierHotelMapping && (plan.contract.supplierHotelMapping.hotelId !== plan.roomType.hotelId || plan.contract.supplierHotelMapping.status !== 'MAPPED')) {
    reasons.push('SUPPLIER_MAPPING_INVALID')
  }
  if (plan.status !== 'ACTIVE') reasons.push('RATE_PLAN_INACTIVE')
  const dailyRate = plan.dailyRates[0]
  if (!dailyRate || dailyRate.amountMinor <= 0n) reasons.push('DAILY_RATE_MISSING_OR_INVALID')
  else if (dailyRate.currency !== plan.currency) reasons.push('RATE_CURRENCY_MISMATCH')
  else if (dailyRate.amountBasis === null) reasons.push('RATE_AMOUNT_BASIS_UNVERIFIED')
  else if (dailyRate.amountBasis === 'NET') reasons.push('NET_RATE_MARKUP_UNAVAILABLE')
  const availability = plan.availability[0]
  if (!availability) reasons.push('AVAILABILITY_MISSING')
  else {
    if (availability.stopSell) reasons.push('STOP_SELL')
    if (availability.allotment - availability.sold - availability.held <= 0) reasons.push('NO_INVENTORY')
  }
  return reasons
}

export interface StayNightSnapshot {
  date: string
  rateAmountMinor: bigint | null
  rateCurrency: string | null
  amountBasis: 'NET' | 'SELL' | null
  /** Basis points of the markup rule in force for this night, or null when none applies. Only read for NET rates. */
  markupBasisPoints?: number | null
  availability: null | {
    allotment: number
    sold: number
    held: number
    stopSell: boolean
    minStay: number
    closedToArrival: boolean
    /** Defaults to ALLOTMENT. FREE_SALE needs no stock, ON_REQUEST is never instant, CLOSED never sells. */
    mode?: InventoryModeName
    /** Provenance. Defaults to ADMIN (never expires unless freshUntil is set). SUPPLIER_* sources without freshUntil are stale. */
    source?: string
    freshUntil?: string | null
    /** Set when the plan draws stock from a shared pool. `remaining` is capacity-sold-held of the pool day, or null when that pool day does not exist. */
    pool?: { id: string; remaining: number | null; source?: string; freshUntil?: string | null } | null
  }
}

export type InventoryModeName = 'ALLOTMENT' | 'FREE_SALE' | 'ON_REQUEST' | 'CLOSED'
export type AvailabilityStatus = 'available' | 'on_request' | 'unavailable'

export interface ContractedStaySnapshot {
  /** Parsed contract sales markets and nationalities (ADR 0035). Absent means the caller does not model them; they are only enforced when the request names a buyer. */
  marketRules?: ContractMarketRules
  /** The plan's own allow-lists (ADR 0057, S3). Required so a caller cannot omit them and skip the rule. */
  planMarketRules: ContractMarketRules
  hotelContentStatus: string
  roomActive: boolean
  boardActive: boolean
  supplierStatus: string
  hotelMappingStatus: string | null
  hotelMappingHotelId: string | null
  canonicalHotelId: string
  roomMappingStatus: string | null
  contractStatus: string
  contractValidFrom: string
  contractValidTo: string
  contractCurrency: string
  /** The plan's own sale window (ADR 0057), YYYY-MM-DD, or null when it inherits the contract term on that side. Required so a caller cannot omit it and skip the rule. */
  ratePlanValidFrom: string | null
  ratePlanValidTo: string | null
  /** The plan's child and extra-adult lines (ADR 0057, S6). Empty keeps the flat-occupancy rule. Required so a caller cannot omit it and price a child as free. */
  guestPrices: GuestPriceLine[]
  /** Why a derived plan cannot be priced (ADR 0058, S10b), or null. Required so a caller cannot omit it. */
  derivedProblem: string | null
  /** The plan's promotions (ADR 0058, S10a). Empty means none. Required so a caller cannot omit them and skip a discount the buyer was promised. */
  promotions: PromotionRule[]
  /** True when the plan names a cancellation rule set that has no rules (ADR 0057). Required so a caller cannot omit it. */
  cancellationPolicyMissing: boolean
  ratePlanStatus: string
  ratePlanOccupancy: number
  ratePlanCurrency: string
  ratePlanMinStay: number
  ratePlanMaxStay: number | null
  ratePlanReleaseDays: number
  /** Hotel-local HH:mm cut-off on the release day. Defaults to 00:00. */
  ratePlanReleaseTimeLocal?: string
  /** IANA zone of the hotel. Required for the release rule; missing or invalid fails closed. */
  hotelTimeZone?: string
  /** closedToDeparture of the availability row dated on the DEPARTURE day. A missing row is not closed. */
  departureClosed?: boolean
  maxAdults: number
  maxChildren: number
  maxOccupancy: number
  nights: StayNightSnapshot[]
}

export interface StayRequest {
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  /** Ages of the children in each room, needed to price a plan that has child lines. Ignored by a plan without them. */
  childAges?: number[]
  currency: string
  /** The instant of evaluation. Freshness and the hotel-local release deadline are judged against it. */
  now: Date
  /**
   * Who is buying. Agent search, recheck and hold pass it, and the contract's sales markets and nationalities are then enforced (ADR 0035).
   * Admin diagnostics are buyer-independent and omit it, so they never report a plan unsellable because of a market.
   */
  buyer?: BuyerContext
}

export interface StayDecision {
  eligible: boolean
  reasons: string[]
  /** What the buyer pays for the stay: net plus markup for NET rates, the stored sell rate for SELL rates. */
  totalMinor: bigint | null
  /** Supplier cost for the stay (equals the total for SELL rates). */
  netMinor: bigint | null
  /** Markup included in the total. Zero for SELL rates. */
  markupMinor: bigint | null
  /** `on_request` only when ON_REQUEST_ONLY is the sole blocker: the stay is priced but must never be presented or treated as confirmed. */
  availabilityStatus: AvailabilityStatus
  /** Smallest remaining unit count across counted nights, or null when no night is counted (free sale / on request). */
  minRemaining: number | null
  /** The one promotion that priced this stay (ADR 0058), with its saving on the net across all rooms; null when none applied. */
  promotion?: (AppliedPromotion & { rooms: number }) | null
}

/** Fresh iff now < freshUntil. No expiry is allowed only for non-supplier sources; supplier data without an expiry is stale. */
export function rowIsFresh(source: string, freshUntil: string | null, now: Date): boolean {
  if (freshUntil === null) return !source.startsWith('SUPPLIER_')
  const until = Date.parse(freshUntil)
  return Number.isFinite(until) && now.getTime() < until
}

export function stayNightCount(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / NIGHT_MS)
}

export function stayDates(checkIn: string, checkOut: string): string[] {
  const count = stayNightCount(checkIn, checkOut)
  const start = Date.parse(`${checkIn}T00:00:00.000Z`)
  return Array.from({ length: count }, (_, index) => new Date(start + index * NIGHT_MS).toISOString().slice(0, 10))
}

export function evaluateContractedStay(snapshot: ContractedStaySnapshot, request: StayRequest): StayDecision {
  const reasons: string[] = []
  const nightCount = stayNightCount(request.checkIn, request.checkOut)
  if (snapshot.hotelContentStatus !== 'COMPLETE') reasons.push('HOTEL_INACTIVE')
  if (!snapshot.roomActive) reasons.push('ROOM_TYPE_INACTIVE')
  if (!snapshot.boardActive) reasons.push('BOARD_BASIS_INACTIVE')
  if (snapshot.supplierStatus !== 'ACTIVE') reasons.push('SUPPLIER_INACTIVE')
  // ADR 0057, S6: a plan without guest price lines keeps the flat rule exactly; a plan with lines prices the party per night.
  const guestPricing = resolveGuestPricing({ planOccupancy: snapshot.ratePlanOccupancy, currency: snapshot.ratePlanCurrency, adults: request.adults, children: request.children, childAges: request.childAges, lines: snapshot.guestPrices, limits: { maxAdults: snapshot.maxAdults, maxChildren: snapshot.maxChildren, maxOccupancy: snapshot.maxOccupancy } })
  if (request.rooms < 1) reasons.push('OCCUPANCY_UNSUPPORTED')
  reasons.push(...guestPricing.reasons)
  const extraPerNight = guestPricing.mode === 'LINES' ? guestPricing.extraMinorPerNight : 0n
  const guestBasis = guestPricing.mode === 'LINES' ? guestPricing.basis : null
  if (snapshot.contractStatus !== 'ACTIVE') reasons.push('CONTRACT_INACTIVE')
  if (request.checkIn < snapshot.contractValidFrom || request.checkOut > snapshot.contractValidTo) reasons.push('OUTSIDE_CONTRACT_VALIDITY')
  if ((snapshot.ratePlanValidFrom !== null && request.checkIn < snapshot.ratePlanValidFrom) || (snapshot.ratePlanValidTo !== null && request.checkOut > snapshot.ratePlanValidTo)) reasons.push('OUTSIDE_RATE_PLAN_VALIDITY')
  if (snapshot.cancellationPolicyMissing) reasons.push('CANCELLATION_POLICY_MISSING')
  if (snapshot.derivedProblem !== null) reasons.push(snapshot.derivedProblem)
  if (snapshot.hotelMappingStatus !== 'MAPPED' || snapshot.hotelMappingHotelId !== snapshot.canonicalHotelId || snapshot.roomMappingStatus !== 'MAPPED') {
    reasons.push('SUPPLIER_MAPPING_INVALID')
  }
  if (snapshot.ratePlanStatus !== 'ACTIVE') reasons.push('RATE_PLAN_INACTIVE')
  if (snapshot.contractCurrency !== request.currency || snapshot.ratePlanCurrency !== request.currency) reasons.push('RATE_CURRENCY_MISMATCH')
  if (nightCount < snapshot.ratePlanMinStay || snapshot.nights.some((night) => (night.availability?.minStay ?? 1) > nightCount)) reasons.push('MIN_STAY_NOT_MET')
  if (snapshot.ratePlanMaxStay !== null && nightCount > snapshot.ratePlanMaxStay) reasons.push('MAX_STAY_EXCEEDED')
  if (!releaseAllows(request.now, request.checkIn, snapshot.ratePlanReleaseDays, snapshot.ratePlanReleaseTimeLocal ?? '00:00', snapshot.hotelTimeZone ?? '')) reasons.push('RELEASE_DAYS_NOT_MET')
  if (snapshot.departureClosed) reasons.push('CLOSED_TO_DEPARTURE')
  if (request.buyer) {
    reasons.push(...marketReasons(snapshot.marketRules ?? { salesMarkets: [], nationalities: [] }, request.buyer))
    reasons.push(...planMarketReasons(snapshot.planMarketRules, request.buyer))
  }

  // Per night: the net before any promotion (rate plus guest lines) and the markup in force for it. The promotion and the markup are applied after the loop.
  const nightNets: Array<{ net: bigint; bp: number | null } | null> = []
  let sawRate = false
  let sawInvalidRate = false
  let sawCurrencyMismatch = false
  let sawUnverified = false
  let sawGuestBasisMismatch = false
  let sawNet = false
  let sawMissingAvailability = false
  let sawStopSell = false
  let sawClosedArrival = false
  let sawNoInventory = false
  let sawPoolExhausted = false
  let sawClosedMode = false
  let sawOnRequest = false
  let sawStale = false
  let minRemaining: number | null = null
  snapshot.nights.forEach((night, index) => {
    if (night.rateAmountMinor === null || night.rateAmountMinor <= 0n) sawInvalidRate = true
    else {
      sawRate = true
      if (night.rateCurrency !== snapshot.ratePlanCurrency || night.rateCurrency !== request.currency) sawCurrencyMismatch = true
      else if (night.amountBasis === null) sawUnverified = true
      else if (guestBasis !== null && guestBasis !== night.amountBasis) sawGuestBasisMismatch = true
      else if (night.amountBasis === 'NET') {
        // NET sells only under a valid markup rule; anything else stays unsellable (fail closed). Guest lines are added to the nightly net BEFORE the promotion and the markup.
        const bp = night.markupBasisPoints
        if (bp === null || bp === undefined || !Number.isSafeInteger(bp) || bp < 0 || bp > MAX_MARKUP_BASIS_POINTS) sawNet = true
        else nightNets[index] = { net: night.rateAmountMinor + extraPerNight, bp }
      } else nightNets[index] = { net: night.rateAmountMinor + extraPerNight, bp: null }
    }
    if (!night.availability) sawMissingAvailability = true
    else {
      if (night.availability.stopSell) sawStopSell = true
      if (index === 0 && night.availability.closedToArrival) sawClosedArrival = true
      const mode = night.availability.mode ?? 'ALLOTMENT'
      if (!rowIsFresh(night.availability.source ?? 'ADMIN', night.availability.freshUntil ?? null, request.now)) sawStale = true
      if (mode === 'CLOSED') sawClosedMode = true
      else if (mode === 'ON_REQUEST') sawOnRequest = true
      else if (mode === 'ALLOTMENT') {
        const pool = night.availability.pool
        if (pool) {
          if (pool.remaining !== null && !rowIsFresh(pool.source ?? 'ADMIN', pool.freshUntil ?? null, request.now)) sawStale = true
          if (pool.remaining === null) sawMissingAvailability = true
          else {
            minRemaining = minRemaining === null ? pool.remaining : Math.min(minRemaining, pool.remaining)
            if (pool.remaining < request.rooms) sawPoolExhausted = true
          }
        } else {
          const remaining = night.availability.allotment - night.availability.sold - night.availability.held
          minRemaining = minRemaining === null ? remaining : Math.min(minRemaining, remaining)
          if (remaining < request.rooms) sawNoInventory = true
        }
      }
    }
  })
  if (!sawRate || sawInvalidRate || snapshot.nights.length !== nightCount) reasons.push('DAILY_RATE_MISSING_OR_INVALID')
  if (sawCurrencyMismatch) reasons.push('RATE_CURRENCY_MISMATCH')
  if (sawUnverified) reasons.push('RATE_AMOUNT_BASIS_UNVERIFIED')
  if (sawGuestBasisMismatch) reasons.push('GUEST_PRICE_BASIS_MISMATCH')
  if (sawNet) reasons.push('NET_RATE_MARKUP_UNAVAILABLE')
  if (sawMissingAvailability) reasons.push('AVAILABILITY_MISSING')
  if (sawStopSell) reasons.push('STOP_SELL')
  if (sawClosedArrival) reasons.push('CLOSED_TO_ARRIVAL')
  if (sawNoInventory) reasons.push('NO_INVENTORY')
  if (sawPoolExhausted) reasons.push('POOL_EXHAUSTED')
  if (sawClosedMode) reasons.push('INVENTORY_CLOSED')
  if (sawStale) reasons.push('INVENTORY_STALE')
  if (sawOnRequest) reasons.push('ON_REQUEST_ONLY')

  // ADR 0058: order is rate + guest lines -> ONE promotion -> markup on the discounted net. Only a fully priced stay is discounted.
  let perRoom = 0n
  let perRoomNet = 0n
  let promotion: StayDecision['promotion'] = null
  const priced = snapshot.nights.length > 0 && nightNets.length === snapshot.nights.length && nightNets.every((entry) => entry !== undefined && entry !== null)
  if (priced) {
    const entries = nightNets as Array<{ net: bigint; bp: number | null }>
    let nets = entries.map((entry) => entry.net)
    const selected = snapshot.promotions.length === 0 ? null : selectPromotion(snapshot.promotions, { today: hotelToday(request.now, snapshot.hotelTimeZone), checkIn: request.checkIn, dates: snapshot.nights.map((night) => night.date) }, nets)
    if (selected) { nets = selected.nets; promotion = { ...selected.applied, rooms: request.rooms } }
    nets.forEach((net, i) => { perRoomNet += net; perRoom += net + (entries[i]!.bp === null ? 0n : markupMinor(net, entries[i]!.bp!)) })
  }

  const unique = [...new Set(reasons)]
  const onRequestOnly = unique.length === 1 && unique[0] === 'ON_REQUEST_ONLY' && request.rooms >= 1
  if ((unique.length > 0 && !onRequestOnly) || request.rooms < 1) return { eligible: false, reasons: unique, totalMinor: null, netMinor: null, markupMinor: null, availabilityStatus: 'unavailable', minRemaining: null, promotion: null }
  const total = perRoom * BigInt(request.rooms)
  const net = perRoomNet * BigInt(request.rooms)
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) return { eligible: false, reasons: ['DAILY_RATE_MISSING_OR_INVALID'], totalMinor: null, netMinor: null, markupMinor: null, availabilityStatus: 'unavailable', minRemaining: null, promotion: null }
  if (onRequestOnly) return { eligible: false, reasons: unique, totalMinor: total, netMinor: net, markupMinor: total - net, availabilityStatus: 'on_request', minRemaining: null, promotion }
  return { eligible: true, reasons: [], totalMinor: total, netMinor: net, markupMinor: total - net, availabilityStatus: 'available', minRemaining, promotion }
}
