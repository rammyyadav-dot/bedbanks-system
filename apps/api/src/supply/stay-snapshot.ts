import type { ContractedStaySnapshot, InventoryModeName, StayNightSnapshot } from './contracted-sellability'

const dayKey = (value: Date): string => value.toISOString().slice(0, 10)

/** Structural shape of a rate plan with the relations the canonical stay evaluator needs. Prisma payloads satisfy it. */
export interface StayPlanInput {
  status: string
  occupancy: number
  currency: string
  minStay: number
  maxStay: number | null
  releaseDays: number
  releaseTimeLocal?: string
  inventoryPoolId?: string | null
  /** The plan's pool with the stock days of the window. Absent when the plan has no pool. */
  inventoryPool?: { days: PoolDayInput[] } | null
  roomType: { hotelId: string; isActive: boolean; maxAdults: number; maxChildren: number; maxOccupancy: number; hotel: { contentStatus: string; timeZone?: string } }
  boardBasis: { isActive: boolean }
  contract: { status: string; validFrom: Date; validTo: Date; settlementCurrency: string; supplier: { status: string } }
  dailyRates: Array<{ stayDate: Date; amountMinor: bigint; currency: string; amountBasis: string | null }>
  availability: Array<{ stayDate: Date; allotment: number; sold: number; held: number; stopSell: boolean; minStay: number; closedToArrival: boolean; closedToDeparture?: boolean; inventoryMode?: string; source?: string; freshUntil?: Date | null }>
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
export function buildStaySnapshot(
  plan: StayPlanInput,
  mapping: { status: string; hotelId: string } | null,
  roomMapping: { status: string } | null,
  nights: string[],
  /** Markup basis points in force for a night, or null. Omitted means no markup rule (NET rates stay unsellable). */
  markupFor?: (date: string) => number | null,
): ContractedStaySnapshot {
  const rates = new Map(plan.dailyRates.map((rate) => [dayKey(rate.stayDate), rate]))
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
        allotment: row.allotment, sold: row.sold, held: row.held, stopSell: row.stopSell, minStay: row.minStay, closedToArrival: row.closedToArrival,
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
    ratePlanStatus: plan.status,
    ratePlanOccupancy: plan.occupancy,
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
