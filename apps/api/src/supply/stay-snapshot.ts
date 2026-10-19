import { parseMarketRules } from './market-rules'
import { rulesForPlan } from './cancellation-rules'
import { effectiveGuestLines, type GuestPriceLine } from './guest-pricing'
import type { PromotionKind, PromotionRule } from './promotions'
import type { ContractedStaySnapshot, InventoryModeName, StayNightSnapshot } from './contracted-sellability'
import { supplementsForPlan } from './supplements'

const dayKey = (value: Date): string => value.toISOString().slice(0, 10)

/** Structural shape of a rate plan with the relations the canonical stay evaluator needs. Prisma payloads satisfy it. */
export interface StayPlanInput {
  /** ADR 0067: the plan and its board pick the contract supplements that apply. */
  id: string
  boardBasisId: string
  status: string
  occupancy: number
  currency: string
  minStay: number
  maxStay: number | null
  releaseDays: number
  releaseTimeLocal?: string
  /** ADR 0057 sale window. Required (nullable) so a narrow `select` that forgets it fails type-check instead of skipping the rule. */
  validFrom: Date | null
  validTo: Date | null
  /** ADR 0057. Required (nullable) for the same reason as the sale window. */
  cancellationPolicySet: string | null
  /** ADR 0057 S6 child and extra-adult lines. Required: a loader that forgot them would otherwise price every child as free. */
  guestPrices: Array<{ kind: string; minAge: number; maxAge: number; amountMinor: bigint; amountBasis: string; currency: string }>
  /** ADR 0058 S10b. Null for a plan that is not derived; otherwise why the derived plan cannot be priced (see `withDerivedRates`). Required so a loader that skipped it cannot sell a derived plan from nothing. */
  derivedProblem: string | null
  /** ADR 0058 S10a promotions. Required: a loader that forgot them would silently sell at full price a plan the hotel discounted. */
  promotions: Array<{ id: string; kind: string; name: string; percentBp: number | null; minLeadDays: number | null; maxLeadDays: number | null; minNights: number | null; freeNights: number | null; bookFrom: Date | null; bookTo: Date | null; stayFrom: Date | null; stayTo: Date | null }>
  /** ADR 0057 S3 allow-lists. Required (any JSON) so a loader that forgot them fails loudly rather than reading as unrestricted. */
  salesMarkets: unknown
  nationalities: unknown
  inventoryPoolId?: string | null
  /** The plan's pool with the stock days of the window. Absent when the plan has no pool. */
  inventoryPool?: { name?: string; days: PoolDayInput[] } | null
  roomType: { hotelId: string; isActive: boolean; maxAdults: number; maxChildren: number; maxOccupancy: number; hotel: { contentStatus: string; timeZone?: string } }
  boardBasis: { isActive: boolean }
  /** ADR 0067 F-02: the contract's booking lead-time rule (zero or one row). Required so a loader that forgot it fails type-check instead of selling inside the cut-off. */
  /** ADR 0067 F-03: the contract child bands, inherited by a plan without CHILD lines of its own. Required for the same reason. */
  contract: { minStayMode: string; supplements: Array<{ kind: string; name: string; boardBasisId: string | null; ratePlanId: string | null; basis: string; frequency: string; amountMinor: bigint; currency: string; stayFrom: Date | null; stayTo: Date | null }>; childPolicies: Array<{ minAge: number; maxAge: number; supplementMinor: bigint | null; currency: string | null }>; leadTimeRules: Array<{ minLeadHours: number; maxLeadDays: number | null }>; cancellationPolicies: Array<{ policySet: string | null }>; status: string; validFrom: Date; validTo: Date; settlementCurrency: string; salesMarkets?: unknown; nationalities?: unknown; supplier: { status: string } }
  dailyRates: Array<{ stayDate: Date; occupancy?: number; amountMinor: bigint; currency: string; amountBasis: string | null }>
  availability: Array<{ stayDate: Date; allotment: number; sold: number; held: number; stopSell: boolean; minStay: number; closedToArrival: boolean; releaseDays: number | null; closedToDeparture?: boolean; inventoryMode?: string; source?: string; freshUntil?: Date | null }>
}

/** One night of a shared pool's stock. Loaded for the plan's pool only; tenant, hotel and supplier isolation is enforced by the loader and the DB. */
export interface PoolDayInput { stayDate: Date; capacity: number; sold: number; held: number; source?: string; freshUntil?: Date | null }

const isoOrNull = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)

/**
 * The single place a `ContractedStaySnapshot` is built. The Agent search adapter and the Admin commercial views both call it,
 * so a hotel's Admin readiness and its Agent offers cannot drift apart. A missing mapping is passed as `null`; the evaluator then
 * reports SUPPLIER_MAPPING_INVALID exactly as it would for an unapproved one.
 */
/** The occupancy whose rates price this stay: the party's adults when every night has such a rate, else the plan's own occupancy. */
export function pricedOccupancy(plan: Pick<StayPlanInput, 'occupancy' | 'dailyRates'>, nights: readonly string[], party?: { adults: number }): number {
  const adults = party?.adults
  if (adults === undefined || adults === plan.occupancy || !Number.isInteger(adults) || adults < 1 || nights.length === 0) return plan.occupancy
  const covered = new Set(plan.dailyRates.filter((rate) => rate.occupancy === adults).map((rate) => dayKey(rate.stayDate)))
  return nights.every((night) => covered.has(night)) ? adults : plan.occupancy
}

export function buildStaySnapshot(
  plan: StayPlanInput,
  mapping: { status: string; hotelId: string } | null,
  roomMapping: { status: string } | null,
  nights: string[],
  /** Markup basis points in force for a night, or null. Omitted means no markup rule (NET rates stay unsellable). */
  markupFor?: (date: string) => number | null,
  /** The party being priced (ADR 0067, F-05). When every night has a rate for exactly this many adults, that occupancy prices the stay. */
  party?: { adults: number },
): ContractedStaySnapshot {
  // A loader that forgot the plan window would silently skip the rule (fail open). Refuse loudly instead.
  if (plan.validFrom === undefined || plan.validTo === undefined) throw new Error('RATE_PLAN_WINDOW_NOT_LOADED')
  if (plan.cancellationPolicySet === undefined || plan.contract.cancellationPolicies === undefined) throw new Error('RATE_PLAN_CANCELLATION_NOT_LOADED')
  if (plan.salesMarkets === undefined || plan.nationalities === undefined) throw new Error('RATE_PLAN_MARKETS_NOT_LOADED')
  if (plan.guestPrices === undefined) throw new Error('RATE_PLAN_GUEST_PRICES_NOT_LOADED')
  if (plan.derivedProblem === undefined) throw new Error('RATE_PLAN_DERIVED_NOT_RESOLVED')
  if (plan.promotions === undefined) throw new Error('RATE_PLAN_PROMOTIONS_NOT_LOADED')
  if (plan.contract.leadTimeRules === undefined) throw new Error('CONTRACT_LEAD_TIME_NOT_LOADED')
  if (plan.contract.childPolicies === undefined) throw new Error('CONTRACT_CHILD_POLICY_NOT_LOADED')
  if (plan.contract.supplements === undefined) throw new Error('CONTRACT_SUPPLEMENTS_NOT_LOADED')
  if (plan.contract.minStayMode !== 'STAY_THROUGH' && plan.contract.minStayMode !== 'ARRIVAL') throw new Error('CONTRACT_MIN_STAY_MODE_NOT_LOADED')
  // A loader may bring several occupancies (ADR 0057, S6). ADR 0067 F-05: a plan may be contracted per occupancy (single, double, triple). The
  // party's adult count prices the stay when EVERY night has a rate for it; otherwise the plan's base occupancy does, with guest lines on top
  // (finding F12). Never a mix of occupancies within one stay.
  const occupancy = pricedOccupancy(plan, nights, party)
  const rates = new Map(plan.dailyRates.filter((rate) => (rate.occupancy ?? plan.occupancy) === occupancy).map((rate) => [dayKey(rate.stayDate), rate]))
  const availability = new Map(plan.availability.map((row) => [dayKey(row.stayDate), row]))
  // A pooled plan whose night has no pool day is reported AVAILABILITY_MISSING, never zero.
  const pools = new Map((plan.inventoryPool?.days ?? []).map((day) => [dayKey(day.stayDate), day]))
  const departureRow = nights.length > 0 ? availability.get(nextDay(nights[nights.length - 1])) : undefined
  const stayNights: StayNightSnapshot[] = nights.map((date) => {
    const rate = rates.get(date)
    const row = availability.get(date)
    return {
      date,
      rateAmountMinor: rate ? rate.amountMinor : null,
      rateCurrency: rate?.currency ?? null,
      amountBasis: rate?.amountBasis === 'NET' || rate?.amountBasis === 'SELL' ? rate.amountBasis : null,
      markupBasisPoints: rate?.amountBasis === 'NET' && markupFor ? markupFor(date) : null,
      availability: row ? {
        allotment: row.allotment, sold: row.sold, held: row.held, stopSell: row.stopSell, minStay: row.minStay, closedToArrival: row.closedToArrival, releaseDays: row.releaseDays,
        mode: toMode(row.inventoryMode),
        source: row.source ?? 'ADMIN',
        freshUntil: isoOrNull(row.freshUntil),
        pool: plan.inventoryPoolId ? poolStock(plan.inventoryPoolId, pools.get(date)) : null,
      } : null,
    }
  })
  return {
    hotelContentStatus: plan.roomType.hotel.contentStatus,
    roomActive: plan.roomType.isActive,
    boardActive: plan.boardBasis.isActive,
    supplierStatus: plan.contract.supplier.status,
    hotelMappingStatus: mapping?.status ?? null,
    hotelMappingHotelId: mapping?.hotelId ?? null,
    canonicalHotelId: plan.roomType.hotelId,
    roomMappingStatus: roomMapping?.status ?? null,
    contractStatus: plan.contract.status,
    contractValidFrom: dayKey(plan.contract.validFrom),
    contractValidTo: dayKey(plan.contract.validTo),
    contractCurrency: plan.contract.settlementCurrency,
    guestPrices: effectiveGuestLines(plan.guestPrices.map((line): GuestPriceLine => ({ kind: line.kind as GuestPriceLine['kind'], minAge: line.minAge, maxAge: line.maxAge, amountMinor: line.amountMinor, basis: line.amountBasis as GuestPriceLine['basis'], currency: line.currency })), plan.contract.childPolicies, plan.currency),
    derivedProblem: plan.derivedProblem,
    promotions: plan.promotions.map((promo): PromotionRule => ({ id: promo.id, kind: promo.kind as PromotionKind, name: promo.name, percentBp: promo.percentBp, minLeadDays: promo.minLeadDays, maxLeadDays: promo.maxLeadDays, minNights: promo.minNights, freeNights: promo.freeNights, bookFrom: promo.bookFrom ? dayKey(promo.bookFrom) : null, bookTo: promo.bookTo ? dayKey(promo.bookTo) : null, stayFrom: promo.stayFrom ? dayKey(promo.stayFrom) : null, stayTo: promo.stayTo ? dayKey(promo.stayTo) : null })),
    cancellationPolicyMissing: rulesForPlan(plan, plan.contract.cancellationPolicies).missing,
    leadTimeRule: plan.contract.leadTimeRules[0] ? { minLeadHours: plan.contract.leadTimeRules[0].minLeadHours, maxLeadDays: plan.contract.leadTimeRules[0].maxLeadDays } : null,
    minStayMode: plan.contract.minStayMode,
    supplements: supplementsForPlan({ id: plan.id, boardBasisId: plan.boardBasisId }, plan.contract.supplements),
    ratePlanValidFrom: plan.validFrom ? dayKey(plan.validFrom) : null,
    ratePlanValidTo: plan.validTo ? dayKey(plan.validTo) : null,
    marketRules: parseMarketRules(plan.contract),
    planMarketRules: parseMarketRules(plan),
    ratePlanStatus: plan.status,
    ratePlanOccupancy: occupancy,
    ratePlanCurrency: plan.currency,
    ratePlanMinStay: plan.minStay,
    ratePlanMaxStay: plan.maxStay,
    ratePlanReleaseDays: plan.releaseDays,
    ratePlanReleaseTimeLocal: plan.releaseTimeLocal ?? '00:00',
    hotelTimeZone: plan.roomType.hotel.timeZone ?? '',
    departureClosed: departureRow?.closedToDeparture === true,
    maxAdults: plan.roomType.maxAdults,
    maxChildren: plan.roomType.maxChildren,
    maxOccupancy: plan.roomType.maxOccupancy,
    nights: stayNights,
  }
}

function toMode(value: string | undefined): InventoryModeName {
  // An unknown mode must not sell: treat it as CLOSED.
  return value === undefined ? 'ALLOTMENT' : value === 'ALLOTMENT' || value === 'FREE_SALE' || value === 'ON_REQUEST' || value === 'CLOSED' ? value : 'CLOSED'
}

function poolStock(id: string, day: PoolDayInput | undefined): { id: string; remaining: number | null; source: string; freshUntil: string | null } {
  return { id, remaining: day ? day.capacity - day.sold - day.held : null, source: day?.source ?? 'ADMIN', freshUntil: isoOrNull(day?.freshUntil) }
}

/** Counted stock of one plan-night: the pool day for a pooled plan, the plan row otherwise. Null remaining means not counted or unknown; `mode` says which. */
export function nightStock(plan: Pick<StayPlanInput, 'inventoryPoolId' | 'inventoryPool' | 'availability'>, date: string): { mode: InventoryModeName | null; remaining: number | null } {
  const row = plan.availability.find((r) => dayKey(r.stayDate) === date)
  if (!row) return { mode: null, remaining: null }
  const mode = toMode(row.inventoryMode)
  if (mode !== 'ALLOTMENT') return { mode, remaining: null }
  if (plan.inventoryPoolId) {
    const day = plan.inventoryPool?.days.find((d) => dayKey(d.stayDate) === date)
    return { mode, remaining: day ? day.capacity - day.sold - day.held : null }
  }
  return { mode, remaining: row.allotment - row.sold - row.held }
}
