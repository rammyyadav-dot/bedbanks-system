import { markupMinor } from '@bedbanks/pricing'
import { evaluateContractedStay, type ContractedStaySnapshot } from './contracted-sellability'

/**
 * Critical-path contract rate calculation: integer minor units only, fail-closed NET markup,
 * promotion-then-markup order. The evaluator is the one search, recheck and hold all call.
 */
const request = { checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 1, adults: 2, children: 0, currency: 'AED', now: new Date('2026-10-05T00:00:00.000Z') }

function night(date: string, patch: Partial<ContractedStaySnapshot['nights'][number]> = {}): ContractedStaySnapshot['nights'][number] {
  return {
    date,
    rateAmountMinor: 30_000n,
    rateCurrency: 'AED',
    amountBasis: 'NET',
    markupBasisPoints: 1_500,
    availability: { allotment: 5, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false },
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
    contractValidFrom: '2026-01-01',
    contractValidTo: '2026-12-31',
    contractCurrency: 'AED',
    guestPrices: [], promotions: [], derivedProblem: null,
    cancellationPolicyMissing: false,
    leadTimeRule: null,
    minStayMode: 'STAY_THROUGH',
    supplements: [],
    eventSupplements: [],
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

describe('contract rate calculation (critical flow)', () => {
  it('marks up each NET night in integer minor units and keeps net + markup = sell', () => {
    const nightlyNet = 30_000n
    const nightlyMarkup = markupMinor(nightlyNet, 1_500)
    expect(nightlyMarkup).toBe(4_500n)
    const decision = evaluateContractedStay(snapshot(), request)
    expect(decision).toMatchObject({
      eligible: true,
      netMinor: nightlyNet * 3n,
      markupMinor: nightlyMarkup * 3n,
      totalMinor: (nightlyNet + nightlyMarkup) * 3n,
    })
    expect(decision.netMinor! + decision.markupMinor!).toBe(decision.totalMinor)
  })

  it('discounts the net first, then marks the discounted net up (never the other way around)', () => {
    const promotions = [{
      id: 'p1', kind: 'LONG_STAY' as const, name: 'Stay 3 save 10%', percentBp: 1_000,
      minLeadDays: null, maxLeadDays: null, minNights: 3, freeNights: null,
      bookFrom: null, bookTo: null, stayFrom: null, stayTo: null,
    }]
    const decision = evaluateContractedStay(snapshot({ promotions }), request)
    const discountedNet = markupMinor(30_000n, 9_000) // 10% off is 90% of net, expressed as leftover
    expect(discountedNet).toBe(27_000n)
    const markup = markupMinor(27_000n, 1_500)
    expect(decision).toMatchObject({
      eligible: true,
      netMinor: 27_000n * 3n,
      markupMinor: markup * 3n,
      totalMinor: (27_000n + markup) * 3n,
      promotion: expect.objectContaining({ kind: 'LONG_STAY', savingMinor: 9_000n }),
    })
  })

  it('adds a compulsory supplement after the promotion and before the markup', () => {
    const promotions = [{
      id: 'p1', kind: 'LONG_STAY' as const, name: 'Stay 3 save 10%', percentBp: 1_000,
      minLeadDays: null, maxLeadDays: null, minNights: 3, freeNights: null,
      bookFrom: null, bookTo: null, stayFrom: null, stayTo: null,
    }]
    const supplements = [{
      name: 'Gala dinner', kind: 'COMPULSORY' as const, basis: 'PER_ROOM' as const, frequency: 'PER_STAY' as const,
      amountMinor: 5_000n, currency: 'AED', stayFrom: null, stayTo: null,
    }]
    const decision = evaluateContractedStay(snapshot({ promotions, supplements }), request)
    // 27,000 x 3 nights + 5,000 gala = 86,000 net; 15% markup = 12,900; sell 98,900
    expect(decision).toMatchObject({
      eligible: true,
      netMinor: 86_000n,
      markupMinor: markupMinor(86_000n, 1_500),
      totalMinor: 86_000n + markupMinor(86_000n, 1_500),
      supplements: [{ name: 'Gala dinner', kind: 'COMPULSORY', amountMinor: 5_000n }],
    })
  })

  it('never sells a NET stay without a markup rule, and never at a guessed zero price', () => {
    const decision = evaluateContractedStay(snapshot({
      nights: [night('2026-10-15', { markupBasisPoints: null }), night('2026-10-16', { markupBasisPoints: null }), night('2026-10-17', { markupBasisPoints: null })],
    }), request)
    expect(decision).toMatchObject({ eligible: false, totalMinor: null, netMinor: null, markupMinor: null })
    expect(decision.reasons).toContain('NET_RATE_MARKUP_UNAVAILABLE')
  })

  it('multiplies rooms after pricing one room, still in integer minor units', () => {
    const one = evaluateContractedStay(snapshot(), request)
    const two = evaluateContractedStay(snapshot(), { ...request, rooms: 2 })
    expect(two.totalMinor).toBe(one.totalMinor! * 2n)
    expect(two.netMinor).toBe(one.netMinor! * 2n)
    expect(two.markupMinor).toBe(one.markupMinor! * 2n)
  })
})
