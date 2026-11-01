import { evaluateContractedStay, type StayDecision, type StayRequest } from './contracted-sellability'
import { markupResolverFor, type MarkupRuleRow } from './markup-rules'
import { buildStaySnapshot, type StayPlanInput } from './stay-snapshot'

/**
 * Certification of the hotel inventory and pricing chain as Agent search walks it:
 * hotel master -> room -> contract -> daily rates -> supplements -> promotions -> markup -> agent search decision,
 * with stop-sell, allotment and availability on every stage. One evaluator, exact integer minor units.
 */

const NOW = new Date('2026-10-05T08:00:00.000Z')
const NIGHTS = ['2026-10-15', '2026-10-16', '2026-10-17']
const at = (d: string) => new Date(`${d}T00:00:00.000Z`)
const request: StayRequest = { checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 1, adults: 2, children: 0, currency: 'AED', now: NOW, detail: true }

type Avail = StayPlanInput['availability'][number]
const avail = (d: string, patch: Partial<Avail> = {}): Avail => ({ stayDate: at(d), allotment: 5, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false, releaseDays: null, closedToDeparture: false, inventoryMode: 'ALLOTMENT', source: 'ADMIN', freshUntil: null, ...patch })
const allRows = (nightPatch: (d: string) => Partial<Avail> = () => ({}), departure: Partial<Avail> = {}) => [...NIGHTS.map((d) => avail(d, nightPatch(d))), avail('2026-10-18', departure)]

const LONG_STAY_10 = { id: 'promo-1', kind: 'LONG_STAY', name: 'Stay 3 save 10%', percentBp: 1000, minLeadDays: null, maxLeadDays: null, minNights: 3, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, combinable: false, stayWindowMode: 'WHOLE_STAY', discountBase: 'ROOM_AND_GUESTS' }
const GALA = { kind: 'COMPULSORY', name: 'Gala dinner', boardBasisId: null, ratePlanId: null, basis: 'PER_ROOM', frequency: 'PER_NIGHT', amountMinor: 5_000n, currency: 'AED', stayFrom: null, stayTo: null }

function plan(over: Partial<StayPlanInput> = {}, basis: 'NET' | 'SELL' = 'NET', rows: Avail[] = allRows()): StayPlanInput {
  return {
    id: 'plan-1', boardBasisId: 'bb-bb', status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1, maxStay: null, validFrom: null, validTo: null, cancellationPolicySet: null,
    promotions: [], dealRules: [], derivedProblem: null, salesMarkets: [], nationalities: [], guestPrices: [], releaseDays: 0, releaseTimeLocal: '00:00',
    inventoryPoolId: null, inventoryPool: null,
    roomType: { hotelId: 'h1', isActive: true, maxAdults: 2, maxChildren: 0, maxOccupancy: 2, hotel: { contentStatus: 'COMPLETE', timeZone: 'Asia/Dubai' } },
    boardBasis: { isActive: true },
    contract: { cancellationPolicies: [], leadTimeRules: [], minStayMode: 'STAY_THROUGH', supplements: [], eventSupplements: [], childPolicies: [], status: 'ACTIVE', validFrom: at('2026-01-01'), validTo: at('2027-01-01'), settlementCurrency: 'AED', supplier: { status: 'ACTIVE' } },
    dailyRates: [...NIGHTS, '2026-10-18'].map((d) => ({ stayDate: at(d), amountMinor: 30_000n, currency: 'AED', amountBasis: basis })),
    availability: rows,
    ...over,
  }
}

const HOTEL_RULE: MarkupRuleRow = { scope: 'HOTEL', supplierId: null, hotelId: 'h1', basisPoints: 1500, validFrom: '2026-01-01', validTo: null }
const SUPPLIER_RULE: MarkupRuleRow = { scope: 'SUPPLIER', supplierId: 's1', hotelId: null, basisPoints: 1000, validFrom: '2026-01-01', validTo: null }
const TENANT_RULE: MarkupRuleRow = { scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints: 800, validFrom: '2026-01-01', validTo: null }

/** Exactly what search does: markup resolved per night, then the one shared evaluator. */
function search(p: StayPlanInput, rules: readonly MarkupRuleRow[] = [HOTEL_RULE], req: Partial<StayRequest> = {}): StayDecision {
  const snapshot = buildStaySnapshot(p, { status: 'MAPPED', hotelId: 'h1' }, { status: 'MAPPED' }, NIGHTS, markupResolverFor(rules, 's1', 'h1'))
  return evaluateContractedStay(snapshot, { ...request, ...req })
}

describe('pricing chain: contract -> daily rates -> supplements -> promotion -> markup', () => {
  it('SELL rate is sold as stored, with no markup, in exact minor units', () => {
    const d = search(plan({}, 'SELL'), [])
    expect(d).toMatchObject({ eligible: true, totalMinor: 90_000n, netMinor: 90_000n, markupMinor: 0n, minRemaining: 5 })
  })

  it('NET rate adds the HOTEL markup per night: 30,000 + 15% = 34,500 x 3', () => {
    const d = search(plan())
    expect(d).toMatchObject({ eligible: true, netMinor: 90_000n, markupMinor: 13_500n, totalMinor: 103_500n })
    expect(d.nightly?.map((n) => n.sellMinor)).toEqual([34_500n, 34_500n, 34_500n])
  })

  it('a compulsory supplement is added after the promotion (never discounted) and marked up with the rate', () => {
    // 30,000 -10% = 27,000; + 5,000 gala = 32,000; + 15% = 4,800 -> 36,800 per night.
    const p = plan({ promotions: [LONG_STAY_10], contract: { ...plan().contract, supplements: [GALA] } })
    const d = search(p)
    expect(d.eligible).toBe(true)
    expect(d.nightly).toEqual(NIGHTS.map((date) => ({ date, netBeforeMinor: 30_000n, promotionMinor: 3_000n, supplementMinor: 5_000n, netMinor: 32_000n, markupMinor: 4_800n, sellMinor: 36_800n })))
    expect(d).toMatchObject({ netMinor: 96_000n, markupMinor: 14_400n, totalMinor: 110_400n })
    expect(d.promotion).toMatchObject({ id: 'promo-1', savingMinor: 9_000n })
    expect(d.supplements).toEqual([{ name: 'Gala dinner', kind: 'COMPULSORY', amountMinor: 15_000n }])
  })

  it('net + markup always equals the total, and rooms multiply every component', () => {
    const p = plan({ promotions: [LONG_STAY_10], contract: { ...plan().contract, supplements: [GALA] } }, 'NET', allRows(() => ({ allotment: 5 })))
    const d = search(p, [HOTEL_RULE], { rooms: 2 })
    expect(d).toMatchObject({ eligible: true, netMinor: 192_000n, markupMinor: 28_800n, totalMinor: 220_800n })
    expect(d.netMinor! + d.markupMinor!).toBe(d.totalMinor)
    expect(d.supplements?.[0]?.amountMinor).toBe(30_000n)
  })

  it('a promotion that does not qualify leaves the rate untouched', () => {
    const d = search(plan({ promotions: [{ ...LONG_STAY_10, minNights: 4 }] }))
    expect(d.promotion).toBeNull(); expect(d.totalMinor).toBe(103_500n)
  })

  it('markup rounds half up in integer minor units (33,335 x 15% = 5,000.25 -> 5,000)', () => {
    const p = plan({ dailyRates: NIGHTS.map((d) => ({ stayDate: at(d), amountMinor: 33_335n, currency: 'AED', amountBasis: 'NET' })).concat({ stayDate: at('2026-10-18'), amountMinor: 33_335n, currency: 'AED', amountBasis: 'NET' }) })
    const d = search(p)
    expect(d.nightly?.[0]).toMatchObject({ markupMinor: 5_000n, sellMinor: 38_335n })
    expect(typeof d.totalMinor).toBe('bigint')
  })
})

describe('markup precedence and fail-closed behaviour', () => {
  it('hotel outranks supplier outranks tenant default', () => {
    expect(search(plan(), [TENANT_RULE, SUPPLIER_RULE, HOTEL_RULE]).totalMinor).toBe(103_500n)
    expect(search(plan(), [TENANT_RULE, SUPPLIER_RULE]).totalMinor).toBe(99_000n)
    expect(search(plan(), [TENANT_RULE]).totalMinor).toBe(97_200n)
  })

  it('a hotel rule that has ended falls back to the supplier rule', () => {
    expect(search(plan(), [{ ...HOTEL_RULE, validTo: '2026-09-30' }, SUPPLIER_RULE]).totalMinor).toBe(99_000n)
  })

  it('a rule that starts mid-stay prices only its nights; the others fall back', () => {
    const d = search(plan(), [SUPPLIER_RULE, { ...HOTEL_RULE, validFrom: '2026-10-17' }])
    expect(d.nightly?.map((n) => n.sellMinor)).toEqual([33_000n, 33_000n, 34_500n])
  })

  it('a NET rate with no markup rule is never sold, and never shown at net', () => {
    const d = search(plan(), [])
    expect(d).toMatchObject({ eligible: false, totalMinor: null, netMinor: null, availabilityStatus: 'unavailable' })
    expect(d.reasons).toContain('NET_RATE_MARKUP_UNAVAILABLE')
  })

  it('a SELL rate ignores markup rules entirely', () => {
    expect(search(plan({}, 'SELL'), [HOTEL_RULE]).totalMinor).toBe(90_000n)
  })
})

describe('contract, rate and master gates', () => {
  it.each([
    ['hotel not published', { roomType: { ...plan().roomType, hotel: { contentStatus: 'DRAFT', timeZone: 'Asia/Dubai' } } }, 'HOTEL_INACTIVE'],
    ['room inactive', { roomType: { ...plan().roomType, isActive: false } }, 'ROOM_TYPE_INACTIVE'],
    ['plan not active', { status: 'DRAFT' }, 'RATE_PLAN_INACTIVE'],
    ['contract not active', { contract: { ...plan().contract, status: 'DRAFT' } }, 'CONTRACT_INACTIVE'],
    ['contract ended before the stay', { contract: { ...plan().contract, validTo: at('2026-10-16') } }, 'OUTSIDE_CONTRACT_VALIDITY'],
    ['supplier suspended', { contract: { ...plan().contract, supplier: { status: 'SUSPENDED' } } }, 'SUPPLIER_INACTIVE'],
    ['contract currency differs', { contract: { ...plan().contract, settlementCurrency: 'USD' } }, 'RATE_CURRENCY_MISMATCH'],
  ] as Array<[string, Partial<StayPlanInput>, string]>)('%s is unsellable (%s)', (_name, patch, code) => {
    const d = search(plan(patch))
    expect(d).toMatchObject({ eligible: false, totalMinor: null })
    expect(d.reasons).toContain(code)
  })

  it('unmapped supplier hotel is unsellable', () => {
    const snapshot = buildStaySnapshot(plan(), null, null, NIGHTS, markupResolverFor([HOTEL_RULE], 's1', 'h1'))
    expect(evaluateContractedStay(snapshot, request).reasons).toContain('SUPPLIER_MAPPING_INVALID')
  })

  it('a missing or zero daily rate is never priced as free', () => {
    const missing = search(plan({ dailyRates: plan().dailyRates.filter((r) => r.stayDate.toISOString().slice(0, 10) !== '2026-10-16') }))
    expect(missing).toMatchObject({ eligible: false, totalMinor: null }); expect(missing.reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
    const zero = search(plan({ dailyRates: plan().dailyRates.map((r) => ({ ...r, amountMinor: 0n })) }))
    expect(zero).toMatchObject({ eligible: false, totalMinor: null }); expect(zero.reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
  })

  it('a rate row with an unverified basis is not sold', () => {
    const d = search(plan({ dailyRates: plan().dailyRates.map((r) => ({ ...r, amountBasis: null })) }))
    expect(d.eligible).toBe(false); expect(d.reasons).toContain('RATE_AMOUNT_BASIS_UNVERIFIED')
  })

  it('a supplement in another currency blocks the sale rather than being added', () => {
    const d = search(plan({ contract: { ...plan().contract, supplements: [{ ...GALA, currency: 'USD' }] } }))
    expect(d.eligible).toBe(false); expect(d.reasons).toContain('SUPPLEMENT_CURRENCY_MISMATCH')
  })

  it('min / max stay of the plan are enforced', () => {
    expect(search(plan({ minStay: 4 })).reasons).toContain('MIN_STAY_NOT_MET')
    expect(search(plan({ maxStay: 2 })).reasons).toContain('MAX_STAY_EXCEEDED')
  })
})

describe('stop-sell', () => {
  it('stop-sell on any single night closes the whole stay, with no price returned', () => {
    for (const closed of NIGHTS) {
      const d = search(plan({}, 'NET', allRows((x) => (x === closed ? { stopSell: true } : {}))))
      expect(d).toMatchObject({ eligible: false, totalMinor: null, netMinor: null, markupMinor: null, availabilityStatus: 'unavailable' })
      expect(d.reasons).toContain('STOP_SELL')
    }
  })

  it('stop-sell on the departure date does not block the stay', () => {
    expect(search(plan({}, 'NET', allRows(() => ({}), { stopSell: true }))).eligible).toBe(true)
  })

  it('stop-sell outside the stay does not affect it', () => {
    const rows = [...allRows(), avail('2026-10-19', { stopSell: true }), avail('2026-10-14', { stopSell: true })]
    expect(search(plan({}, 'NET', rows)).eligible).toBe(true)
  })

  it('stop-sell beats remaining stock and a promotion: stock is plentiful yet nothing is returned', () => {
    const d = search(plan({ promotions: [LONG_STAY_10] }, 'NET', allRows((x) => (x === '2026-10-16' ? { stopSell: true, allotment: 99 } : { allotment: 99 }))))
    expect(d.eligible).toBe(false); expect(d.promotion ?? null).toBeNull()
  })

  it('lifting the stop-sell makes the same stay sellable again at the same price', () => {
    const closed = search(plan({}, 'NET', allRows(() => ({ stopSell: true }))))
    const open = search(plan({}, 'NET', allRows(() => ({ stopSell: false }))))
    expect(closed.eligible).toBe(false); expect(open).toMatchObject({ eligible: true, totalMinor: 103_500n })
  })
})

describe('allotment', () => {
  it('remaining is allotment - sold - held, and the stay reports the tightest night', () => {
    const d = search(plan({}, 'NET', allRows((x) => (x === '2026-10-16' ? { allotment: 4, sold: 1, held: 1 } : {}))))
    expect(d).toMatchObject({ eligible: true, minRemaining: 2 })
  })

  it('exactly enough rooms sells; one more room than remaining does not', () => {
    const rows = allRows(() => ({ allotment: 3, sold: 1, held: 0 }))
    expect(search(plan({}, 'NET', rows), [HOTEL_RULE], { rooms: 2 })).toMatchObject({ eligible: true, minRemaining: 2, totalMinor: 207_000n })
    const over = search(plan({}, 'NET', rows), [HOTEL_RULE], { rooms: 3 })
    expect(over).toMatchObject({ eligible: false, totalMinor: null }); expect(over.reasons).toContain('NO_INVENTORY')
  })

  it('held rooms are not sellable even though not yet sold', () => {
    const d = search(plan({}, 'NET', allRows(() => ({ allotment: 2, sold: 0, held: 2 }))))
    expect(d.reasons).toContain('NO_INVENTORY')
  })

  it('one exhausted night sells out the stay', () => {
    const d = search(plan({}, 'NET', allRows((x) => (x === '2026-10-17' ? { allotment: 1, sold: 1 } : {}))))
    expect(d.eligible).toBe(false); expect(d.reasons).toEqual(['NO_INVENTORY'])
  })

  it('an over-sold row (sold + held > allotment) is NO_INVENTORY, never negative stock sold', () => {
    const d = search(plan({}, 'NET', allRows(() => ({ allotment: 1, sold: 2 }))))
    expect(d.eligible).toBe(false); expect(d.reasons).toContain('NO_INVENTORY')
  })

  it('a shared pool sells from the pool day, not the plan row', () => {
    const days = [...NIGHTS, '2026-10-18'].map((d) => ({ stayDate: at(d), capacity: 5, sold: 4, held: 0 }))
    const pooled = plan({ inventoryPoolId: 'pool-1', inventoryPool: { days } }, 'NET', allRows(() => ({ allotment: 99 })))
    expect(search(pooled)).toMatchObject({ eligible: true, minRemaining: 1 })
    const exhausted = search(pooled, [HOTEL_RULE], { rooms: 2 })
    expect(exhausted.eligible).toBe(false); expect(exhausted.reasons).toContain('POOL_EXHAUSTED')
  })

  it('a pooled night with no pool day is AVAILABILITY_MISSING, not zero and not unlimited', () => {
    const days = NIGHTS.slice(0, 2).map((d) => ({ stayDate: at(d), capacity: 5, sold: 0, held: 0 }))
    const d = search(plan({ inventoryPoolId: 'pool-1', inventoryPool: { days } }))
    expect(d.eligible).toBe(false); expect(d.reasons).toContain('AVAILABILITY_MISSING')
  })
})

describe('availability', () => {
  it('a missing availability row is AVAILABILITY_MISSING, never treated as open stock', () => {
    const rows = allRows().filter((r) => r.stayDate.toISOString().slice(0, 10) !== '2026-10-16')
    const d = search(plan({}, 'NET', rows))
    expect(d).toMatchObject({ eligible: false, totalMinor: null }); expect(d.reasons).toContain('AVAILABILITY_MISSING')
  })

  it('closed to arrival applies to the check-in night only', () => {
    expect(search(plan({}, 'NET', allRows((x) => (x === '2026-10-15' ? { closedToArrival: true } : {})))).reasons).toContain('CLOSED_TO_ARRIVAL')
    expect(search(plan({}, 'NET', allRows((x) => (x === '2026-10-16' ? { closedToArrival: true } : {})))).eligible).toBe(true)
  })

  it('closed to departure is read from the departure-date row only', () => {
    expect(search(plan({}, 'NET', allRows(() => ({}), { closedToDeparture: true }))).reasons).toContain('CLOSED_TO_DEPARTURE')
    expect(search(plan({}, 'NET', allRows((x) => (x === '2026-10-16' ? { closedToDeparture: true } : {})))).eligible).toBe(true)
  })

  it('night-level minimum stay is honoured through the stay', () => {
    expect(search(plan({}, 'NET', allRows((x) => (x === '2026-10-16' ? { minStay: 4 } : {})))).reasons).toContain('MIN_STAY_NOT_MET')
  })

  it('release days: a stay inside the release window is not sold; the deadline instant itself is not sellable', () => {
    // Check-in 15 Oct, release 10 days at 00:00 Dubai -> deadline 5 Oct 00:00 +04 = 4 Oct 20:00Z. NOW is 5 Oct 08:00Z, after it.
    expect(search(plan({ releaseDays: 10 })).reasons).toContain('RELEASE_DAYS_NOT_MET')
    expect(search(plan({ releaseDays: 9 })).eligible).toBe(true)
    expect(search(plan({ releaseDays: 10 }), [HOTEL_RULE], { now: new Date('2026-10-04T20:00:00.000Z') }).reasons).toContain('RELEASE_DAYS_NOT_MET')
    expect(search(plan({ releaseDays: 10 }), [HOTEL_RULE], { now: new Date('2026-10-04T19:59:59.999Z') }).eligible).toBe(true)
  })

  it('stale supplier stock fails closed, fresh supplier stock sells', () => {
    const stale = allRows(() => ({ source: 'SUPPLIER_PUSH', freshUntil: new Date('2026-10-05T07:00:00.000Z') }))
    const fresh = allRows(() => ({ source: 'SUPPLIER_PUSH', freshUntil: new Date('2026-10-05T09:00:00.000Z') }))
    expect(search(plan({}, 'NET', stale)).reasons).toContain('INVENTORY_STALE')
    expect(search(plan({}, 'NET', fresh)).eligible).toBe(true)
    expect(search(plan({}, 'NET', allRows(() => ({ source: 'SUPPLIER_PUSH', freshUntil: null })))).reasons).toContain('INVENTORY_STALE')
  })

  it('FREE_SALE sells without counters, ON_REQUEST is priced but never instant, CLOSED never sells', () => {
    expect(search(plan({}, 'NET', allRows(() => ({ inventoryMode: 'FREE_SALE', allotment: 0 })))).eligible).toBe(true)
    const onRequest = search(plan({}, 'NET', allRows(() => ({ inventoryMode: 'ON_REQUEST' }))))
    expect(onRequest).toMatchObject({ eligible: false, availabilityStatus: 'on_request', totalMinor: 103_500n })
    expect(search(plan({}, 'NET', allRows(() => ({ inventoryMode: 'CLOSED' })))).reasons).toContain('INVENTORY_CLOSED')
  })

  it('search is read-only: evaluating twice gives the same answer and never mutates the rows', () => {
    const rows = allRows(() => ({ allotment: 3, sold: 1 }))
    const before = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    const first = search(plan({}, 'NET', rows)); const second = search(plan({}, 'NET', rows))
    expect(second).toEqual(first)
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before)
  })
})

describe('agent search end to end: a full stay across every stage', () => {
  it('sells at 36,800 x 3 nights, then each blocker in turn removes the offer without leaking a price', () => {
    const full = plan({ promotions: [LONG_STAY_10], contract: { ...plan().contract, supplements: [GALA] } })
    expect(search(full)).toMatchObject({ eligible: true, totalMinor: 110_400n, minRemaining: 5 })
    const blockers: Array<[string, StayPlanInput, string]> = [
      ['stop-sell', { ...full, availability: allRows((x) => (x === '2026-10-16' ? { stopSell: true } : {})) }, 'STOP_SELL'],
      ['sold out', { ...full, availability: allRows((x) => (x === '2026-10-17' ? { allotment: 2, sold: 2 } : {})) }, 'NO_INVENTORY'],
      ['no availability row', { ...full, availability: allRows().filter((r) => r.stayDate.toISOString().slice(0, 10) !== '2026-10-15') }, 'AVAILABILITY_MISSING'],
      ['plan paused', { ...full, status: 'PAUSED' }, 'RATE_PLAN_INACTIVE'],
      ['contract expired', { ...full, contract: { ...full.contract, status: 'EXPIRED' } }, 'CONTRACT_INACTIVE'],
    ]
    for (const [, blocked, code] of blockers) {
      const d = search(blocked)
      expect(d.reasons).toContain(code)
      expect(d).toMatchObject({ eligible: false, totalMinor: null, netMinor: null, markupMinor: null })
    }
  })
})
