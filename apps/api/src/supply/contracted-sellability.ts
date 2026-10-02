import { markupMinor, MAX_MARKUP_BASIS_POINTS } from '@bedbanks/pricing'
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
  if (plan.roomType.hotel.contentStatus === 'SUSPENDED') reasons.push('HOTEL_INACTIVE')
  if (!plan.roomType.isActive) reasons.push('ROOM_TYPE_INACTIVE')
  if (!plan.boardBasis.isActive) reasons.push('BOARD_BASIS_INACTIVE')
  if (plan.contract.supplier.status !== 'ACTIVE') reasons.push('SUPPLIER_INACTIVE')
  if (input.occupancy !== plan.occupancy || input.occupancy > plan.roomType.maxOccupancy) reasons.push('OCCUPANCY_UNSUPPORTED')
  if (plan.contract.status !== 'ACTIVE') reasons.push('CONTRACT_INACTIVE')
  if (input.stayDate < plan.contract.validFrom || input.stayDate > plan.contract.validTo) reasons.push('OUTSIDE_CONTRACT_VALIDITY')
  if (plan.contract.supplierHotelMapping && (plan.contract.supplierHotelMapping.hotelId !== plan.roomType.hotelId || plan.contract.supplierHotelMapping.status !== 'MAPPED')) {
    reasons.push('SUPPLIER_MAPPING_INVALID')
  }
  if (plan.status !== 'ACTIVE') reasons.push('RATE_PLAN_INACTIVE')
  const dailyRate = plan.dailyRates[0]
  if (!dailyRate || dailyRate.amountMinor < 0n) reasons.push('DAILY_RATE_MISSING_OR_INVALID')
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
  }
}

export interface ContractedStaySnapshot {
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
  ratePlanStatus: string
  ratePlanOccupancy: number
  ratePlanCurrency: string
  ratePlanMinStay: number
  ratePlanMaxStay: number | null
  ratePlanReleaseDays: number
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
  currency: string
  leadDays: number
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
}

export function stayNightCount(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / NIGHT_MS)
}

export function commercialLeadDays(checkIn: string, now: Date = new Date()): number {
  const checkInAt = new Date(`${checkIn}T00:00:00.000Z`)
  return Math.floor((checkInAt.getTime() - now.getTime()) / NIGHT_MS)
}

export function stayDates(checkIn: string, checkOut: string): string[] {
  const count = stayNightCount(checkIn, checkOut)
  const start = Date.parse(`${checkIn}T00:00:00.000Z`)
  return Array.from({ length: count }, (_, index) => new Date(start + index * NIGHT_MS).toISOString().slice(0, 10))
}

export function evaluateContractedStay(snapshot: ContractedStaySnapshot, request: StayRequest): StayDecision {
  const reasons: string[] = []
  const guests = request.adults + request.children
  const nightCount = stayNightCount(request.checkIn, request.checkOut)
  if (snapshot.hotelContentStatus !== 'COMPLETE') reasons.push('HOTEL_INACTIVE')
  if (!snapshot.roomActive) reasons.push('ROOM_TYPE_INACTIVE')
  if (!snapshot.boardActive) reasons.push('BOARD_BASIS_INACTIVE')
  if (snapshot.supplierStatus !== 'ACTIVE') reasons.push('SUPPLIER_INACTIVE')
  if (request.rooms < 1 || guests !== snapshot.ratePlanOccupancy || request.adults > snapshot.maxAdults || request.children > snapshot.maxChildren || guests > snapshot.maxOccupancy) {
    reasons.push('OCCUPANCY_UNSUPPORTED')
  }
  if (snapshot.contractStatus !== 'ACTIVE') reasons.push('CONTRACT_INACTIVE')
  if (request.checkIn < snapshot.contractValidFrom || request.checkOut > snapshot.contractValidTo) reasons.push('OUTSIDE_CONTRACT_VALIDITY')
  if (snapshot.hotelMappingStatus !== 'MAPPED' || snapshot.hotelMappingHotelId !== snapshot.canonicalHotelId || snapshot.roomMappingStatus !== 'MAPPED') {
    reasons.push('SUPPLIER_MAPPING_INVALID')
  }
  if (snapshot.ratePlanStatus !== 'ACTIVE') reasons.push('RATE_PLAN_INACTIVE')
  if (snapshot.contractCurrency !== request.currency || snapshot.ratePlanCurrency !== request.currency) reasons.push('RATE_CURRENCY_MISMATCH')
  if (nightCount < snapshot.ratePlanMinStay || snapshot.nights.some((night) => (night.availability?.minStay ?? 1) > nightCount)) reasons.push('MIN_STAY_NOT_MET')
  if (snapshot.ratePlanMaxStay !== null && nightCount > snapshot.ratePlanMaxStay) reasons.push('MAX_STAY_EXCEEDED')
  if (request.leadDays < snapshot.ratePlanReleaseDays) reasons.push('RELEASE_DAYS_NOT_MET')

  let perRoom = 0n
  let perRoomNet = 0n
  let sawRate = false
  let sawInvalidRate = false
  let sawCurrencyMismatch = false
  let sawUnverified = false
  let sawNet = false
  let sawMissingAvailability = false
  let sawStopSell = false
  let sawClosedArrival = false
  let sawNoInventory = false
  snapshot.nights.forEach((night, index) => {
    if (night.rateAmountMinor === null || night.rateAmountMinor < 0n) sawInvalidRate = true
    else {
      sawRate = true
      if (night.rateCurrency !== snapshot.ratePlanCurrency || night.rateCurrency !== request.currency) sawCurrencyMismatch = true
      else if (night.amountBasis === null) sawUnverified = true
      else if (night.amountBasis === 'NET') {
        // NET sells only under a valid markup rule; anything else stays unsellable (fail closed).
        const bp = night.markupBasisPoints
        if (bp === null || bp === undefined || !Number.isSafeInteger(bp) || bp < 0 || bp > MAX_MARKUP_BASIS_POINTS) sawNet = true
        else { perRoomNet += night.rateAmountMinor; perRoom += night.rateAmountMinor + markupMinor(night.rateAmountMinor, bp) }
      } else { perRoomNet += night.rateAmountMinor; perRoom += night.rateAmountMinor }
    }
    if (!night.availability) sawMissingAvailability = true
    else {
      if (night.availability.stopSell) sawStopSell = true
      if (index === 0 && night.availability.closedToArrival) sawClosedArrival = true
      const remaining = night.availability.allotment - night.availability.sold - night.availability.held
      if (remaining < request.rooms) sawNoInventory = true
    }
  })
  if (!sawRate || sawInvalidRate || snapshot.nights.length !== nightCount) reasons.push('DAILY_RATE_MISSING_OR_INVALID')
  if (sawCurrencyMismatch) reasons.push('RATE_CURRENCY_MISMATCH')
  if (sawUnverified) reasons.push('RATE_AMOUNT_BASIS_UNVERIFIED')
  if (sawNet) reasons.push('NET_RATE_MARKUP_UNAVAILABLE')
  if (sawMissingAvailability) reasons.push('AVAILABILITY_MISSING')
  if (sawStopSell) reasons.push('STOP_SELL')
  if (sawClosedArrival) reasons.push('CLOSED_TO_ARRIVAL')
  if (sawNoInventory) reasons.push('NO_INVENTORY')

  const unique = [...new Set(reasons)]
  if (unique.length > 0 || request.rooms < 1) return { eligible: false, reasons: unique, totalMinor: null, netMinor: null, markupMinor: null }
  const total = perRoom * BigInt(request.rooms)
  const net = perRoomNet * BigInt(request.rooms)
  if (total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) return { eligible: false, reasons: ['DAILY_RATE_MISSING_OR_INVALID'], totalMinor: null, netMinor: null, markupMinor: null }
  return { eligible: true, reasons: [], totalMinor: total, netMinor: net, markupMinor: total - net }
}
