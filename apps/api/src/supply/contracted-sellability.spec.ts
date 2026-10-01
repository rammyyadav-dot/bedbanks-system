import { evaluateContractedStay, evaluateNightSellability, type ContractedStaySnapshot, type NightSellabilityPlan } from './contracted-sellability'

const request = { checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 1, adults: 2, children: 0, currency: 'AED', leadDays: 10 }

function night(date: string, patch: Partial<ContractedStaySnapshot['nights'][number]> = {}): ContractedStaySnapshot['nights'][number] {
  return {
    date,
    rateAmountMinor: 29900n,
    rateCurrency: 'AED',
    amountBasis: 'SELL',
    availability: { allotment: 4, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false },
    ...patch,
  }
}

function snapshot(patch: Partial<ContractedStaySnapshot> = {}): ContractedStaySnapshot {
  return {
    hotelContentStatus: 'COMPLETE',
    roomActive: true,
    boardActive: true,
    supplierStatus: 'ACTIVE',
    hotelMappingStatus: 'MAPPED',
    hotelMappingHotelId: 'hotel-a',
    canonicalHotelId: 'hotel-a',
    roomMappingStatus: 'MAPPED',
    contractStatus: 'ACTIVE',
    contractValidFrom: '2026-10-01',
    contractValidTo: '2026-12-31',
    contractCurrency: 'AED',
    ratePlanStatus: 'ACTIVE',
    ratePlanOccupancy: 2,
    ratePlanCurrency: 'AED',
    ratePlanMinStay: 1,
    ratePlanMaxStay: 14,
    ratePlanReleaseDays: 0,
    maxAdults: 2,
    maxChildren: 0,
    maxOccupancy: 2,
    nights: [night('2026-10-15'), night('2026-10-16'), night('2026-10-17')],
    ...patch,
  }
}

describe('contracted stay sellability', () => {
  it('prices three AED nights in integer minor units', () => {
    expect(evaluateContractedStay(snapshot(), request)).toEqual({ eligible: true, reasons: [], totalMinor: 89700n })
  })

  it.each([
    ['supplier inactive', { supplierStatus: 'SUSPENDED' }, 'SUPPLIER_INACTIVE'],
    ['hotel inactive', { hotelContentStatus: 'SUSPENDED' }, 'HOTEL_INACTIVE'],
    ['hotel mapping pending', { hotelMappingStatus: 'PENDING' }, 'SUPPLIER_MAPPING_INVALID'],
    ['hotel mapping rejected', { hotelMappingStatus: 'REJECTED' }, 'SUPPLIER_MAPPING_INVALID'],
    ['room mapping pending', { roomMappingStatus: 'PENDING' }, 'SUPPLIER_MAPPING_INVALID'],
    ['room mapping rejected', { roomMappingStatus: 'REJECTED' }, 'SUPPLIER_MAPPING_INVALID'],
    ['inactive contract', { contractStatus: 'SUSPENDED' }, 'CONTRACT_INACTIVE'],
    ['expired contract', { contractStatus: 'EXPIRED' }, 'CONTRACT_INACTIVE'],
    ['inactive rate plan', { ratePlanStatus: 'SUSPENDED' }, 'RATE_PLAN_INACTIVE'],
    ['currency mismatch', { ratePlanCurrency: 'USD' }, 'RATE_CURRENCY_MISMATCH'],
    ['unsupported occupancy', { maxAdults: 1 }, 'OCCUPANCY_UNSUPPORTED'],
  ] as const)('fails closed for %s', (_name, patch, reason) => {
    const decision = evaluateContractedStay(snapshot(patch), request)
    expect(decision.eligible).toBe(false)
    expect(decision.reasons).toContain(reason)
    expect(decision.totalMinor).toBeNull()
  })

  it('fails when one night has no rate', () => {
    const decision = evaluateContractedStay(snapshot({ nights: [night('2026-10-15'), night('2026-10-16', { rateAmountMinor: null }), night('2026-10-17')] }), request)
    expect(decision.reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
  })

  it('fails when one night has no availability', () => {
    const decision = evaluateContractedStay(snapshot({ nights: [night('2026-10-15'), night('2026-10-16', { availability: null }), night('2026-10-17')] }), request)
    expect(decision.reasons).toContain('AVAILABILITY_MISSING')
  })

  it('fails when remaining allotment is below the requested rooms', () => {
    const depleted = { allotment: 2, sold: 2, held: 0, stopSell: false, minStay: 1, closedToArrival: false }
    const decision = evaluateContractedStay(snapshot({ nights: [night('2026-10-15', { availability: depleted }), night('2026-10-16'), night('2026-10-17')] }), request)
    expect(decision.eligible).toBe(false)
    expect(decision.reasons).toContain('NO_INVENTORY')
    expect(evaluateContractedStay(snapshot(), { ...request, rooms: 5 }).reasons).toContain('NO_INVENTORY')
  })

  it('fails for stop sell, minimum stay, and release days', () => {
    expect(evaluateContractedStay(snapshot({ nights: [night('2026-10-15', { availability: { allotment: 4, sold: 0, held: 0, stopSell: true, minStay: 1, closedToArrival: false } }), night('2026-10-16'), night('2026-10-17')] }), request).reasons).toContain('STOP_SELL')
    expect(evaluateContractedStay(snapshot({ ratePlanMinStay: 5 }), request).reasons).toContain('MIN_STAY_NOT_MET')
    expect(evaluateContractedStay(snapshot({ ratePlanReleaseDays: 30 }), request).reasons).toContain('RELEASE_DAYS_NOT_MET')
  })

  it('keeps the single-night admin reasons for an eligible SELL night', () => {
    const plan: NightSellabilityPlan = {
      status: 'ACTIVE', occupancy: 2, currency: 'AED',
      roomType: { isActive: true, maxOccupancy: 2, hotelId: 'hotel-a', hotel: { contentStatus: 'DRAFT' } },
      boardBasis: { isActive: true },
      contract: { status: 'ACTIVE', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2026-12-31T00:00:00.000Z'), supplier: { status: 'ACTIVE' }, supplierHotelMapping: null },
      dailyRates: [{ amountMinor: 29900n, currency: 'AED', amountBasis: 'SELL' }],
      availability: [{ stopSell: false, allotment: 4, sold: 1, held: 1 }],
    }
    expect(evaluateNightSellability(plan, { stayDate: new Date('2026-10-15T00:00:00.000Z'), occupancy: 2 })).toEqual([])
    expect(evaluateNightSellability(null, { stayDate: new Date('2026-10-15T00:00:00.000Z'), occupancy: 2 })).toEqual(['RATE_PLAN_MISSING'])
  })
})
