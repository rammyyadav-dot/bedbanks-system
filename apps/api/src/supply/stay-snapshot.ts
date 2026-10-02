import type { ContractedStaySnapshot, StayNightSnapshot } from './contracted-sellability'

const dayKey = (value: Date): string => value.toISOString().slice(0, 10)

/** Structural shape of a rate plan with the relations the canonical stay evaluator needs. Prisma payloads satisfy it. */
export interface StayPlanInput {
  status: string
  occupancy: number
  currency: string
  minStay: number
  maxStay: number | null
  releaseDays: number
  roomType: { hotelId: string; isActive: boolean; maxAdults: number; maxChildren: number; maxOccupancy: number; hotel: { contentStatus: string } }
  boardBasis: { isActive: boolean }
  contract: { status: string; validFrom: Date; validTo: Date; settlementCurrency: string; supplier: { status: string } }
  dailyRates: Array<{ stayDate: Date; amountMinor: bigint; currency: string; amountBasis: string | null }>
  availability: Array<{ stayDate: Date; allotment: number; sold: number; held: number; stopSell: boolean; minStay: number; closedToArrival: boolean }>
}

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
  const stayNights: StayNightSnapshot[] = nights.map((date) => {
    const rate = rates.get(date)
    const row = availability.get(date)
    return {
      date,
      rateAmountMinor: rate ? rate.amountMinor : null,
      rateCurrency: rate?.currency ?? null,
      amountBasis: rate?.amountBasis === 'NET' || rate?.amountBasis === 'SELL' ? rate.amountBasis : null,
      markupBasisPoints: rate?.amountBasis === 'NET' && markupFor ? markupFor(date) : null,
      availability: row ? { allotment: row.allotment, sold: row.sold, held: row.held, stopSell: row.stopSell, minStay: row.minStay, closedToArrival: row.closedToArrival } : null,
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
    maxAdults: plan.roomType.maxAdults,
    maxChildren: plan.roomType.maxChildren,
    maxOccupancy: plan.roomType.maxOccupancy,
    nights: stayNights,
  }
}
