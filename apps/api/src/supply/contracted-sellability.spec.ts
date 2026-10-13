import type { PromotionRule } from './promotions'
import { evaluateContractedStay, evaluateNightSellability, type ContractedStaySnapshot, type NightSellabilityPlan } from './contracted-sellability'

const request = { checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 1, adults: 2, children: 0, currency: 'AED', now: new Date('2026-10-05T00:00:00.000Z') }

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
    guestPrices: [], promotions: [], derivedProblem: null,
    cancellationPolicyMissing: false,
    planMarketRules: { salesMarkets: [], nationalities: [] },
    ratePlanValidFrom: null,
    ratePlanValidTo: null,
    ratePlanStatus: 'ACTIVE',
    ratePlanOccupancy: 2,
    ratePlanCurrency: 'AED',
    ratePlanMinStay: 1,
    ratePlanMaxStay: 14,
    ratePlanReleaseDays: 0,
    ratePlanReleaseTimeLocal: '00:00',
    hotelTimeZone: 'Asia/Dubai',
    maxAdults: 2,
    maxChildren: 0,
    maxOccupancy: 2,
    nights: [night('2026-10-15'), night('2026-10-16'), night('2026-10-17')],
    ...patch,
  }
}

describe('contracted stay sellability', () => {
  it('prices three AED nights in integer minor units', () => {
    expect(evaluateContractedStay(snapshot(), request)).toEqual({ eligible: true, reasons: [], totalMinor: 89700n, netMinor: 89700n, markupMinor: 0n, availabilityStatus: 'available', minRemaining: 4, promotion: null })
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

  it('refuses a stay outside the plan sale window and allows one inside it (ADR 0057)', () => {
    const inside = snapshot({ ratePlanValidFrom: '2026-10-15', ratePlanValidTo: '2026-10-18' })
    expect(evaluateContractedStay(inside, request).reasons).not.toContain('OUTSIDE_RATE_PLAN_VALIDITY')
    expect(evaluateContractedStay(snapshot({ ratePlanValidFrom: '2026-10-16' }), request).reasons).toContain('OUTSIDE_RATE_PLAN_VALIDITY')
    expect(evaluateContractedStay(snapshot({ ratePlanValidTo: '2026-10-17' }), request).reasons).toContain('OUTSIDE_RATE_PLAN_VALIDITY')
    expect(evaluateContractedStay(snapshot({ ratePlanValidFrom: '2026-10-16' }), request).eligible).toBe(false)
  })
  it('a plan naming a cancellation set with no rules is not sellable (ADR 0057)', () => {
    const decision = evaluateContractedStay(snapshot({ cancellationPolicyMissing: true }), request)
    expect(decision.reasons).toContain('CANCELLATION_POLICY_MISSING')
    expect(decision.eligible).toBe(false)
    expect(evaluateContractedStay(snapshot({ cancellationPolicyMissing: false }), request).reasons).not.toContain('CANCELLATION_POLICY_MISSING')
  })
  it('fails when one night has no rate', () => {
    const decision = evaluateContractedStay(snapshot({ nights: [night('2026-10-15'), night('2026-10-16', { rateAmountMinor: null }), night('2026-10-17')] }), request)
    expect(decision.reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
  })

  it('refuses a zero or negative stored rate instead of selling the night for nothing (ADR 0034)', () => {
    for (const bad of [0n, -1n]) {
      const decision = evaluateContractedStay(snapshot({ nights: [night('2026-10-15'), night('2026-10-16', { rateAmountMinor: bad }), night('2026-10-17')] }), request)
      expect(decision).toMatchObject({ eligible: false, totalMinor: null, netMinor: null })
      expect(decision.reasons).toEqual(['DAILY_RATE_MISSING_OR_INVALID'])
    }
    const plan: NightSellabilityPlan = {
      status: 'ACTIVE', occupancy: 2, currency: 'AED', validFrom: null, validTo: null,
      roomType: { isActive: true, maxOccupancy: 2, hotelId: 'hotel-a', hotel: { contentStatus: 'COMPLETE' } },
      boardBasis: { isActive: true },
      contract: { status: 'ACTIVE', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2026-12-31T00:00:00.000Z'), supplier: { status: 'ACTIVE' }, supplierHotelMapping: null },
      dailyRates: [{ amountMinor: 0n, currency: 'AED', amountBasis: 'SELL' }],
      availability: [{ stopSell: false, allotment: 4, sold: 0, held: 0 }],
    }
    expect(evaluateNightSellability(plan, { stayDate: new Date('2026-10-15T00:00:00.000Z'), occupancy: 2 })).toContain('DAILY_RATE_MISSING_OR_INVALID')
    expect(evaluateNightSellability({ ...plan, dailyRates: [{ amountMinor: 1n, currency: 'AED', amountBasis: 'SELL' }] }, { stayDate: new Date('2026-10-15T00:00:00.000Z'), occupancy: 2 })).toEqual([])
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
      status: 'ACTIVE', occupancy: 2, currency: 'AED', validFrom: null, validTo: null,
      roomType: { isActive: true, maxOccupancy: 2, hotelId: 'hotel-a', hotel: { contentStatus: 'DRAFT' } },
      boardBasis: { isActive: true },
      contract: { status: 'ACTIVE', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2026-12-31T00:00:00.000Z'), supplier: { status: 'ACTIVE' }, supplierHotelMapping: null },
      dailyRates: [{ amountMinor: 29900n, currency: 'AED', amountBasis: 'SELL' }],
      availability: [{ stopSell: false, allotment: 4, sold: 1, held: 1 }],
    }
    expect(evaluateNightSellability(plan, { stayDate: new Date('2026-10-15T00:00:00.000Z'), occupancy: 2 })).toEqual([])
    // ADR 0057: the plan's own sale window applies to a single night as well, so Admin diagnostics agree with the stay evaluator.
    const night = { stayDate: new Date('2026-10-15T00:00:00.000Z'), occupancy: 2 }
    expect(evaluateNightSellability({ ...plan, validFrom: new Date('2026-10-16T00:00:00.000Z') }, night)).toContain('OUTSIDE_RATE_PLAN_VALIDITY')
    expect(evaluateNightSellability({ ...plan, validTo: new Date('2026-10-14T00:00:00.000Z') }, night)).toContain('OUTSIDE_RATE_PLAN_VALIDITY')
    expect(evaluateNightSellability({ ...plan, validFrom: new Date('2026-10-15T00:00:00.000Z'), validTo: new Date('2026-10-15T00:00:00.000Z') }, night)).toEqual([])
    expect(evaluateNightSellability(null, { stayDate: new Date('2026-10-15T00:00:00.000Z'), occupancy: 2 })).toEqual(['RATE_PLAN_MISSING'])
  })

  describe('NET rates and markup (ADR 0018)', () => {
    const net = (bp: number | null | undefined, amount = 10_000n) => night('2026-10-15', { amountBasis: 'NET', rateAmountMinor: amount, markupBasisPoints: bp })
    const stay = (nights: ReturnType<typeof net>[], rooms = 1) => evaluateContractedStay(snapshot({ nights }), { ...request, checkOut: '2026-10-' + String(15 + nights.length), rooms })

    it('a NET night with a markup rule sells at net plus markup, and reports both parts', () => {
      const d = stay([net(1_000)])
      expect(d).toEqual({ eligible: true, reasons: [], totalMinor: 11_000n, netMinor: 10_000n, markupMinor: 1_000n, availabilityStatus: 'available', minRemaining: 4, promotion: null })
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
      expect(d).toMatchObject({ eligible: true, totalMinor: 89_700n, netMinor: 89_700n, markupMinor: 0n, availabilityStatus: 'available', minRemaining: 4 })
    })

    it('a zero-percent rule is a valid rule: NET sells at net', () => {
      expect(stay([net(0)])).toMatchObject({ eligible: true, totalMinor: 10_000n, markupMinor: 0n, availabilityStatus: 'available', minRemaining: 4 })
    })
  })
})

describe('child and extra-adult pricing in the stay evaluator (ADR 0057, S6)', () => {
  const room = { maxAdults: 3, maxChildren: 2, maxOccupancy: 4 }
  const child = (minAge: number, maxAge: number, amountMinor: bigint, basis: 'NET' | 'SELL' = 'SELL') => ({ kind: 'CHILD' as const, minAge, maxAge, amountMinor, basis, currency: 'AED' })
  const family = { ...request, adults: 2, children: 2, childAges: [1, 8] }
  const lines = [child(0, 2, 0n), child(3, 11, 10_000n), { kind: 'EXTRA_ADULT' as const, minAge: 18, maxAge: 99, amountMinor: 20_000n, basis: 'SELL' as const, currency: 'AED' }]

  it('a plan without lines is priced and refused exactly as before', () => {
    expect(evaluateContractedStay(snapshot(), { ...request, adults: 2, children: 1, childAges: [5] }).reasons).toContain('OCCUPANCY_UNSUPPORTED')
    expect(evaluateContractedStay(snapshot(), request).totalMinor).toBe(89700n)
  })
  it('adds each child\'s band price per night to the nightly rate: 3 nights x (299.00 + 0 + 100.00)', () => {
    const d = evaluateContractedStay(snapshot({ ...room, guestPrices: lines }), family)
    expect(d).toMatchObject({ eligible: true, reasons: [], totalMinor: 3n * (29900n + 0n + 10_000n), netMinor: 3n * 39_900n, markupMinor: 0n })
  })
  it('prices an extra adult, and a base party without children costs only the base rate', () => {
    expect(evaluateContractedStay(snapshot({ ...room, guestPrices: lines }), { ...request, adults: 3 }).totalMinor).toBe(3n * (29900n + 20_000n))
    expect(evaluateContractedStay(snapshot({ ...room, guestPrices: lines }), request).totalMinor).toBe(89700n)
  })
  it('multiplies by rooms after pricing the party', () => {
    expect(evaluateContractedStay(snapshot({ ...room, guestPrices: lines }), { ...family, rooms: 2 }).totalMinor).toBe(2n * 3n * 39_900n)
  })
  it('adds the lines to the NET rate BEFORE the markup, per night, rounding half up on the combined amount', () => {
    const net = (date: string) => night(date, { amountBasis: 'NET', rateAmountMinor: 10_001n, markupBasisPoints: 1_000 })
    const netLines = [child(3, 11, 5_005n, 'NET')]
    const d = evaluateContractedStay(snapshot({ ...room, guestPrices: netLines, nights: [net('2026-10-15'), net('2026-10-16'), net('2026-10-17')] }), { ...request, adults: 2, children: 1, childAges: [5] })
    // combined net per night 15,006; 10% = 1,500.6 -> 1,501 half up; sell 16,507 per night
    expect(d).toMatchObject({ eligible: true, netMinor: 3n * 15_006n, markupMinor: 3n * 1_501n, totalMinor: 3n * 16_507n })
  })
  it('refuses a child no line covers or without ages, and never prices that child as free', () => {
    const noAge = evaluateContractedStay(snapshot({ ...room, guestPrices: lines }), { ...request, children: 1 })
    expect(noAge.reasons).toContain('CHILD_AGES_REQUIRED'); expect(noAge.totalMinor).toBeNull()
    expect(evaluateContractedStay(snapshot({ ...room, guestPrices: [child(3, 11, 1n)] }), { ...request, children: 1, childAges: [1] }).reasons).toContain('CHILD_AGE_NOT_COVERED')
  })
  it('refuses a line whose basis differs from the night\'s rate basis', () => {
    const d = evaluateContractedStay(snapshot({ ...room, guestPrices: [child(3, 11, 1n, 'NET')] }), { ...request, children: 1, childAges: [5] })
    expect(d.reasons).toContain('GUEST_PRICE_BASIS_MISMATCH'); expect(d.eligible).toBe(false)
  })
  it('the room limits still apply to the whole party', () => {
    expect(evaluateContractedStay(snapshot({ ...room, maxChildren: 1, guestPrices: lines }), family).reasons).toContain('OCCUPANCY_UNSUPPORTED')
  })
})

describe('promotions in the stay price (ADR 0058, S10a)', () => {
  // Check-in is 10 days after `request.now` in Dubai.
  const promo = (over: Partial<PromotionRule> = {}): PromotionRule => ({ id: 'p1', kind: 'EARLY_BIRD', name: 'Book early', percentBp: 1000, minLeadDays: 7, maxLeadDays: null, minNights: null, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, ...over })
  const netNight = (date: string) => night(date, { amountBasis: 'NET', rateAmountMinor: 10_000n, markupBasisPoints: 1_000 })

  it('takes the percentage off each night of a SELL plan', () => {
    const d = evaluateContractedStay(snapshot({ promotions: [promo()] }), request)
    expect(d.totalMinor).toBe(3n * (29_900n - 2_990n))
    expect(d.promotion).toMatchObject({ id: 'p1', kind: 'EARLY_BIRD', savingMinor: 3n * 2_990n })
  })

  it('discounts the net first and then marks that net up', () => {
    const d = evaluateContractedStay(snapshot({ promotions: [promo({ percentBp: 2000 })], nights: ['2026-10-15', '2026-10-16', '2026-10-17'].map(netNight) }), request)
    expect(d.netMinor).toBe(3n * 8_000n)
    expect(d.markupMinor).toBe(3n * 800n)
    expect(d.totalMinor).toBe(3n * 8_800n)
  })

  it('does not apply when the booking lead is short, the zone is unknown, or the stay is outside the window', () => {
    expect(evaluateContractedStay(snapshot({ promotions: [promo({ minLeadDays: 11 })] }), request).totalMinor).toBe(89_700n)
    expect(evaluateContractedStay(snapshot({ promotions: [promo()], hotelTimeZone: 'Mars/Base' }), request).promotion).toBeNull()
    expect(evaluateContractedStay(snapshot({ promotions: [promo({ stayTo: '2026-10-16' })] }), request).promotion).toBeNull()
  })

  it('makes the cheapest night free and multiplies by rooms', () => {
    const free = promo({ id: 'p2', kind: 'FREE_NIGHTS', percentBp: null, minLeadDays: null, minNights: 3, freeNights: 1 })
    const d = evaluateContractedStay(snapshot({ promotions: [free], maxAdults: 2 }), { ...request, rooms: 2 })
    expect(d.totalMinor).toBe(2n * 2n * 29_900n)
    expect(d.promotion).toMatchObject({ kind: 'FREE_NIGHTS', savingMinor: 29_900n, rooms: 2 })
  })

  it('applies only the best of several promotions and never stacks them', () => {
    const d = evaluateContractedStay(snapshot({ promotions: [promo({ id: 'a', percentBp: 1000 }), promo({ id: 'b', percentBp: 1500 })] }), request)
    expect(d.promotion?.id).toBe('b')
    expect(d.totalMinor).toBe(3n * (29_900n - 4_485n))
  })

  it('never discounts a stay that is not sellable', () => {
    const d = evaluateContractedStay(snapshot({ promotions: [promo()], ratePlanStatus: 'SUSPENDED' }), request)
    expect(d.eligible).toBe(false)
    expect(d.totalMinor).toBeNull()
  })
})
