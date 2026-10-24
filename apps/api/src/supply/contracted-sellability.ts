import { markupMinor, MAX_MARKUP_BASIS_POINTS } from '@bedbanks/pricing'
import { releaseAllows, zonedLocalToUtc } from './zoned-time'
import { hotelToday } from './rate-plan-expiry'
import { leadDays, selectPromotion, type AppliedPromotion, type PromotionRule } from './promotions'
import { resolveGuestPricing, type GuestPriceLine } from './guest-pricing'
import { marketReasons, planMarketReasons, type BuyerContext, type ContractMarketRules } from './market-rules'
import { supplementNights, type SupplementKind, type SupplementRule } from './supplements'
import { eventSupplementNights, type EventSupplementRule } from './event-supplements'
import { convertMinor, type FxQuote } from './fx'
/**
 * Shared commercial gates for contracted inventory: the ONE evaluator Agent search, recheck, hold, Admin readiness, the hotel assessment, rate
 * certification and the Sellability Inspector all use (ADR 0067, F-07).
 */

const NIGHT_MS = 86_400_000

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
    /** Release override for a check-in on this night (ADR 0067, F-08). Null or absent uses the plan's release. */
    releaseDays?: number | null
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
  /** The contract's booking lead-time rule, or null when it has none (ADR 0067, F-02). Required so a caller cannot omit it and sell inside the cut-off. */
  leadTimeRule: { minLeadHours: number; maxLeadDays: number | null } | null
  /** How a night's minimum stay is read (ADR 0067, F-15): STAY_THROUGH applies every night's value, ARRIVAL only the check-in night's. Required. */
  minStayMode: 'STAY_THROUGH' | 'ARRIVAL'
  /** Board and compulsory supplements of the contract for this plan (ADR 0067). Empty means none. Required so a caller cannot drop a mandatory charge. */
  supplements: SupplementRule[]
  /** Approved, active, eligible event/exhibition supplements of the contract for this plan (ADR 0089). Empty means none. Required so a caller cannot drop a mandatory event charge. */
  eventSupplements: EventSupplementRule[]
  /** ADR 0067 F-12: the controlled rate that sells this contract in the request currency. Absent or null: the request must be in the contract currency. */
  fx?: FxQuote | null
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
  /** Board and compulsory supplements included in the total, each across all rooms (ADR 0067). Absent when none applied. */
  supplements?: Array<{ name: string; kind: SupplementKind; amountMinor: bigint }>
  /** Event/exhibition supplements included in the total, each across all rooms (ADR 0089). Absent when none applied. */
  eventSupplements?: Array<{ roomEventId: string; roomEventName: string; amountMinor: bigint }>
  /** The controlled rate the amounts were converted with (ADR 0067, F-12). Absent when priced in the contract currency. */
  fx?: FxQuote
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
  // ADR 0067 F-06: validFrom and validTo are the first and last STAY NIGHTS (inclusive), as hotels write contract periods. Check-out may be the day after validTo.
  const checkOutMs = Date.parse(`${request.checkOut}T00:00:00.000Z`)
  // An unparseable check-out keeps itself as the bound, so a malformed request never widens validity (the night count rejects it anyway).
  const lastNight = Number.isFinite(checkOutMs) ? new Date(checkOutMs - NIGHT_MS).toISOString().slice(0, 10) : request.checkOut
  if (request.checkIn < snapshot.contractValidFrom || lastNight > snapshot.contractValidTo) reasons.push('OUTSIDE_CONTRACT_VALIDITY')
  if ((snapshot.ratePlanValidFrom !== null && request.checkIn < snapshot.ratePlanValidFrom) || (snapshot.ratePlanValidTo !== null && lastNight > snapshot.ratePlanValidTo)) reasons.push('OUTSIDE_RATE_PLAN_VALIDITY')
  if (snapshot.cancellationPolicyMissing) reasons.push('CANCELLATION_POLICY_MISSING')
  if (snapshot.derivedProblem !== null) reasons.push(snapshot.derivedProblem)
  if (snapshot.hotelMappingStatus !== 'MAPPED' || snapshot.hotelMappingHotelId !== snapshot.canonicalHotelId || snapshot.roomMappingStatus !== 'MAPPED') {
    reasons.push('SUPPLIER_MAPPING_INVALID')
  }
  if (snapshot.ratePlanStatus !== 'ACTIVE') reasons.push('RATE_PLAN_INACTIVE')
  // ADR 0067 F-12: with a controlled rate the stay is priced in the contract currency and converted once at the end; without one the request must be in it.
  const fx = snapshot.fx && snapshot.fx.to === request.currency && snapshot.fx.from !== request.currency ? snapshot.fx : null
  const pricingCurrency = fx ? fx.from : request.currency
  if (snapshot.contractCurrency !== pricingCurrency || snapshot.ratePlanCurrency !== pricingCurrency) reasons.push('RATE_CURRENCY_MISMATCH')
  const minStayNights = snapshot.minStayMode === 'ARRIVAL' ? snapshot.nights.slice(0, 1) : snapshot.nights
  if (nightCount < snapshot.ratePlanMinStay || minStayNights.some((night) => (night.availability?.minStay ?? 1) > nightCount)) reasons.push('MIN_STAY_NOT_MET')
  if (snapshot.ratePlanMaxStay !== null && nightCount > snapshot.ratePlanMaxStay) reasons.push('MAX_STAY_EXCEEDED')
  // ADR 0067 F-08: the check-in night may carry its own release (a period rule); otherwise the plan's applies. The plan's release time applies either way.
  const releaseDays = snapshot.nights[0]?.availability?.releaseDays ?? snapshot.ratePlanReleaseDays
  if (!releaseAllows(request.now, request.checkIn, releaseDays, snapshot.ratePlanReleaseTimeLocal ?? '00:00', snapshot.hotelTimeZone ?? '')) reasons.push('RELEASE_DAYS_NOT_MET')
  if (snapshot.departureClosed) reasons.push('CLOSED_TO_DEPARTURE')
  reasons.push(...leadTimeReasons(snapshot.leadTimeRule, request.now, request.checkIn, snapshot.hotelTimeZone ?? ''))
  if (request.buyer) {
    reasons.push(...marketReasons(snapshot.marketRules ?? { salesMarkets: [], nationalities: [] }, request.buyer))
    reasons.push(...planMarketReasons(snapshot.planMarketRules, request.buyer))
  }

  // Per night: the net before any promotion (rate plus guest lines) and the markup in force for it. The promotion and the markup are applied after the loop.
  const nightNets: Array<{ net: bigint; bp: number | null; base: bigint } | null> = []
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
      if (night.rateCurrency !== snapshot.ratePlanCurrency || night.rateCurrency !== pricingCurrency) sawCurrencyMismatch = true
      else if (night.amountBasis === null) sawUnverified = true
      else if (guestBasis !== null && guestBasis !== night.amountBasis) sawGuestBasisMismatch = true
      else if (night.amountBasis === 'NET') {
        // NET sells only under a valid markup rule; anything else stays unsellable (fail closed). Guest lines are added to the nightly net BEFORE the promotion and the markup.
        const bp = night.markupBasisPoints
        if (bp === null || bp === undefined || !Number.isSafeInteger(bp) || bp < 0 || bp > MAX_MARKUP_BASIS_POINTS) sawNet = true
        else nightNets[index] = { net: night.rateAmountMinor + extraPerNight, bp, base: night.rateAmountMinor }
      } else nightNets[index] = { net: night.rateAmountMinor + extraPerNight, bp: null, base: night.rateAmountMinor }
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

  // ADR 0067: supplements are priced in the plan's currency; anything else is not guessed at.
  if (snapshot.supplements.some((rule) => rule.currency !== snapshot.ratePlanCurrency)) reasons.push('SUPPLEMENT_CURRENCY_MISMATCH')
  // ADR 0089: event supplements are priced in the plan's currency; a mismatch is never silently skipped or converted on a guess.
  if (snapshot.eventSupplements.some((rule) => rule.currency !== snapshot.ratePlanCurrency)) reasons.push('EVENT_SUPPLEMENT_CURRENCY_MISMATCH')

  // ADR 0058: order is rate + guest lines -> ONE promotion -> markup on the discounted net. Only a fully priced stay is discounted.
  // ADR 0067: supplements are added after the promotion (never discounted) and before the markup (a NET rate's supplement is marked up with it).
  let perRoom = 0n
  let perRoomNet = 0n
  let promotion: StayDecision['promotion'] = null
  let supplements: NonNullable<StayDecision['supplements']> = []
  let eventSupplements: NonNullable<StayDecision['eventSupplements']> = []
  const priced = snapshot.nights.length > 0 && nightNets.length === snapshot.nights.length && nightNets.every((entry) => entry !== undefined && entry !== null)
  if (priced) {
    const entries = nightNets as Array<{ net: bigint; bp: number | null; base: bigint }>
    let nets = entries.map((entry) => entry.net)
    const selected = snapshot.promotions.length === 0 ? null : selectPromotion(snapshot.promotions, { today: hotelToday(request.now, snapshot.hotelTimeZone), checkIn: request.checkIn, dates: snapshot.nights.map((night) => night.date) }, nets, entries.map((entry) => entry.base))
    if (selected) { nets = selected.nets; promotion = { ...selected.applied, rooms: request.rooms } }
    const extras = supplementNights(snapshot.supplements, snapshot.nights.map((night) => night.date), { adults: request.adults, children: request.children })
    nets = nets.map((net, i) => net + extras.perNight[i]!)
    supplements = extras.applied.map((item) => ({ ...item, amountMinor: item.amountMinor * BigInt(request.rooms) }))
    // ADR 0089: event supplements price on the night's own contracted base (entries[i].base), never on the promotion-discounted or board/compulsory-adjusted net.
    const eventExtras = eventSupplementNights(snapshot.eventSupplements, snapshot.nights.map((night) => night.date), { adults: request.adults, children: request.children }, entries.map((entry) => entry.base))
    if (eventExtras.ambiguous) reasons.push('EVENT_SUPPLEMENT_CONFLICT')
    nets = nets.map((net, i) => net + eventExtras.perNight[i]!)
    eventSupplements = eventExtras.applied.map((item) => ({ ...item, amountMinor: item.amountMinor * BigInt(request.rooms) }))
    nets.forEach((net, i) => { perRoomNet += net; perRoom += net + (entries[i]!.bp === null ? 0n : markupMinor(net, entries[i]!.bp!)) })
  }

  const unique = [...new Set(reasons)]
  const onRequestOnly = unique.length === 1 && unique[0] === 'ON_REQUEST_ONLY' && request.rooms >= 1
  if ((unique.length > 0 && !onRequestOnly) || request.rooms < 1) return { eligible: false, reasons: unique, totalMinor: null, netMinor: null, markupMinor: null, availabilityStatus: 'unavailable', minRemaining: null, promotion: null }
  const baseTotal = perRoom * BigInt(request.rooms)
  const baseNet = perRoomNet * BigInt(request.rooms)
  // One conversion of the final amounts, never per night, so rounding happens once and net + markup = total still holds.
  const total = fx ? convertMinor(baseTotal, fx) : baseTotal
  const net = fx ? convertMinor(baseNet, fx) : baseNet
  if (fx) {
    if (promotion) promotion = { ...promotion, savingMinor: convertMinor(promotion.savingMinor, fx) }
    supplements = supplements.map((item) => ({ ...item, amountMinor: convertMinor(item.amountMinor, fx) }))
    eventSupplements = eventSupplements.map((item) => ({ ...item, amountMinor: convertMinor(item.amountMinor, fx) }))
  }
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) return { eligible: false, reasons: ['DAILY_RATE_MISSING_OR_INVALID'], totalMinor: null, netMinor: null, markupMinor: null, availabilityStatus: 'unavailable', minRemaining: null, promotion: null }
  const included = { ...(supplements.length ? { supplements } : {}), ...(eventSupplements.length ? { eventSupplements } : {}), ...(fx ? { fx } : {}) }
  if (onRequestOnly) return { eligible: false, reasons: unique, totalMinor: total, netMinor: net, markupMinor: total - net, availabilityStatus: 'on_request', minRemaining: null, promotion, ...included }
  return { eligible: true, reasons: [], totalMinor: total, netMinor: net, markupMinor: total - net, availabilityStatus: 'available', minRemaining, promotion, ...included }
}

/**
 * The contract's booking lead time (ADR 0067, F-02). `minLeadHours`: the booking must be made at least that many hours before the start of the
 * check-in day in the hotel's zone (the stricter reading: a later check-in hour never shortens it). `maxLeadDays`: check-in may be at most that
 * many hotel-local days ahead of today. An unusable zone fails closed for whichever side is set.
 */
export function leadTimeReasons(rule: { minLeadHours: number; maxLeadDays: number | null } | null, now: Date, checkIn: string, timeZone: string): string[] {
  if (!rule) return []
  const reasons: string[] = []
  if (rule.minLeadHours > 0) {
    let arrival: number | null = null
    try { arrival = zonedLocalToUtc(checkIn, '00:00', timeZone).getTime() } catch { arrival = null }
    if (arrival === null || arrival - now.getTime() < rule.minLeadHours * 3_600_000) reasons.push('LEAD_TIME_TOO_SHORT')
  }
  if (rule.maxLeadDays !== null) {
    const today = hotelToday(now, timeZone)
    if (today === null || leadDays(today, checkIn) > rule.maxLeadDays) reasons.push('LEAD_TIME_TOO_LONG')
  }
  return reasons
}
