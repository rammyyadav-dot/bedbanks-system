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
    expect(evaluateContractedStay(snapshot(), request)).toEqual({ eligible: true, reasons: [], totalMinor: 89700n, netMinor: 89700n, markupMinor: 0n })
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

  describe('NET rates and markup (ADR 0018)', () => {
    const net = (bp: number | null | undefined, amount = 10_000n) => night('2026-10-15', { amountBasis: 'NET', rateAmountMinor: amount, markupBasisPoints: bp })
    const stay = (nights: ReturnType<typeof net>[], rooms = 1) => evaluateContractedStay(snapshot({ nights }), { ...request, checkOut: '2026-10-' + String(15 + nights.length), rooms })

    it('a NET night with a markup rule sells at net plus markup, and reports both parts', () => {
      const d = stay([net(1_000)])
      expect(d).toEqual({ eligible: true, reasons: [], totalMinor: 11_000n, netMinor: 10_000n, markupMinor: 1_000n })
    })

    it('rounds each night half up in integer minor units, then sums', () => {
      const d = stay([net(1_000, 10_005n), { ...net(1_000, 10_005n), date: '2026-10-16' }])
      expect(d.markupMinor).toBe(2_002n) // 1001 + 1001, not 2001 from rounding the sum
      expect(d.totalMinor).toBe(22_012n)
    })

    it('multiplies by rooms and keeps net, markup and total consistent', () => {
      const d = stay([net(2_500)], 3)
      expect(d).toMatchObject({ totalMinor: 37_500n, netMinor: 30_000n, markupMinor: 7_500n })
      expect(d.netMinor! + d.markupMinor!).toBe(d.totalMinor)
    })

    it('a NET night with no rule stays unsellable (fail closed), and with an out-of-range rule too', () => {
      for (const bp of [null, undefined, -1, 10_001, 3 / 2]) {
        const d = stay([net(bp as number | null)])
        expect(d.eligible).toBe(false); expect(d.reasons).toContain('NET_RATE_MARKUP_UNAVAILABLE'); expect(d.totalMinor).toBeNull(); expect(d.netMinor).toBeNull()
      }
    })

    it('one night without a rule blocks the whole stay: no partial pricing', () => {
      const d = stay([net(1_000), { ...net(null), date: '2026-10-16' }])
      expect(d.eligible).toBe(false); expect(d.reasons).toContain('NET_RATE_MARKUP_UNAVAILABLE')
    })

    it('SELL rates ignore any markup and are never marked up twice', () => {
      const d = evaluateContractedStay(snapshot({ nights: [night('2026-10-15', { markupBasisPoints: 5_000 }), night('2026-10-16'), night('2026-10-17')] }), request)
      expect(d).toMatchObject({ eligible: true, totalMinor: 89_700n, netMinor: 89_700n, markupMinor: 0n })
    })

    it('a zero-percent rule is a valid rule: NET sells at net', () => {
      expect(stay([net(0)])).toMatchObject({ eligible: true, totalMinor: 10_000n, markupMinor: 0n })
    })
  })
})
