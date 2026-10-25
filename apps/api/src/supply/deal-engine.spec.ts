import { discountedNets, evaluatePromotions, guardBreach, promotionApplies, selectPromotion, weekdayBit, type DealTerms, type PromotionContext, type PromotionRule } from './promotions'
import { evaluateContractedStay, type ContractedStaySnapshot } from './contracted-sellability'

/** ADR 0089: the deal kinds, audience, effective window, guards and stacking exclusions of the one promotion evaluator. Pure arithmetic in integer minor units. */
const NO_DEAL: DealTerms = { amountMinor: null, currency: null, amountScope: null, fromNight: null, weekdays: null, activeFrom: null, activeTo: null, priority: 0, stackingGroup: null, incompatibleWith: [], channels: [], sourceMarkets: [], agencyIds: [], maxDiscountBp: null, minSellFloorMinor: null, minMarginBp: null }
const deal = (over: Partial<PromotionRule> & Pick<PromotionRule, 'kind'>, terms: Partial<DealTerms> = {}): PromotionRule => ({
  id: 'd1', name: 'Deal', percentBp: null, minLeadDays: null, maxLeadDays: null, minNights: null, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null,
  deal: { ...NO_DEAL, ...terms }, ...over,
})
// Tuesday 2026-11-10 to Thursday 2026-11-12 (three nights).
const dates = ['2026-11-10', '2026-11-11', '2026-11-12']
const ctx = (over: Partial<PromotionContext> = {}): PromotionContext => ({ today: '2026-10-12', checkIn: '2026-11-10', dates, currency: 'AED', ...over })
const nets = [10000n, 10000n, 10000n]
const total = (values: readonly bigint[]) => values.reduce((sum, value) => sum + value, 0n)

describe('weekday bits', () => {
  it('Monday is bit 0 and Sunday bit 6', () => {
    expect(weekdayBit('2026-11-09')).toBe(0) // Monday
    expect(weekdayBit('2026-11-10')).toBe(1)
    expect(weekdayBit('2026-11-15')).toBe(6) // Sunday
  })
})

describe('deal kinds: what each prices', () => {
  it('PERCENT_OFF takes a percentage off every eligible night, half up, and honours its minimum nights', () => {
    const r = deal({ kind: 'PERCENT_OFF', percentBp: 1000 })
    expect(discountedNets(r, nets, dates)).toEqual([9000n, 9000n, 9000n])
    expect(promotionApplies({ ...r, minNights: 3 }, ctx())).toBe(true)
    expect(promotionApplies({ ...r, minNights: 4 }, ctx())).toBe(false)
    // half up: 1 percent of 10050 is 100.5, so 101 comes off
    expect(discountedNets(deal({ kind: 'PERCENT_OFF', percentBp: 100 }), [10050n], ['2026-11-10'])).toEqual([9949n])
  })

  it('PERCENT_OFF never takes a night below one minor unit', () => {
    expect(discountedNets(deal({ kind: 'PERCENT_OFF', percentBp: 9000 }), [1n, 2n], ['2026-11-10', '2026-11-11'])).toEqual([1n, 1n])
  })

  it('FLASH_SALE applies only inside a booking window with both ends', () => {
    const flash = deal({ kind: 'FLASH_SALE', percentBp: 2500, bookFrom: '2026-10-10', bookTo: '2026-10-14' })
    expect(promotionApplies(flash, ctx())).toBe(true)
    expect(promotionApplies(flash, ctx({ today: '2026-10-15' }))).toBe(false)
    expect(promotionApplies(flash, ctx({ today: '2026-10-09' }))).toBe(false)
    expect(promotionApplies({ ...flash, bookTo: null }, ctx())).toBe(false)
    expect(promotionApplies({ ...flash, bookFrom: null }, ctx())).toBe(false)
  })

  it('EARLY_BIRD keeps its lead-day rule as a deal', () => {
    const early = deal({ kind: 'EARLY_BIRD', percentBp: 1500, minLeadDays: 29 })
    expect(promotionApplies(early, ctx())).toBe(true)
    expect(promotionApplies({ ...early, minLeadDays: 30 }, ctx())).toBe(false)
  })

  it('SUBSEQUENT_NIGHTS leaves the early nights at full price and discounts from the chosen night', () => {
    const r = deal({ kind: 'SUBSEQUENT_NIGHTS', percentBp: 2000 }, { fromNight: 2 })
    expect(discountedNets(r, nets, dates)).toEqual([10000n, 8000n, 8000n])
    expect(discountedNets(deal({ kind: 'SUBSEQUENT_NIGHTS', percentBp: 2000 }, { fromNight: 3 }), nets, dates)).toEqual([10000n, 10000n, 8000n])
    // a stay too short to have the chosen night gets nothing
    expect(promotionApplies(r, ctx({ dates: ['2026-11-10'] }))).toBe(false)
    expect(promotionApplies(deal({ kind: 'SUBSEQUENT_NIGHTS', percentBp: 2000 }, { fromNight: 4 }), ctx())).toBe(false)
  })

  it('STAY_X_PAY_Y is the cheapest nights free, once, and keeps a paid night', () => {
    const r = deal({ kind: 'FREE_NIGHTS', minNights: 3, freeNights: 1 })
    expect(discountedNets(r, [12000n, 9000n, 11000n], dates)).toEqual([12000n, 0n, 11000n])
    expect(promotionApplies({ ...r, minNights: 4 }, ctx())).toBe(false)
    expect(promotionApplies({ ...r, freeNights: 3 }, ctx())).toBe(false)
  })

  it('EVERY_NTH_FREE frees one cheapest night per full block of N nights', () => {
    const r = deal({ kind: 'EVERY_NTH_FREE', minNights: 3 })
    const week = Array.from({ length: 7 }, (_, i) => `2026-11-${String(10 + i).padStart(2, '0')}`)
    const prices = [7000n, 6000n, 9000n, 5000n, 8000n, 6500n, 7500n]
    // 7 nights, N = 3: two full blocks, so the two cheapest nights (5000 and 6000) are free
    expect(discountedNets(r, prices, week)).toEqual([7000n, 0n, 9000n, 0n, 8000n, 6500n, 7500n])
    expect(promotionApplies(r, ctx({ dates: week }))).toBe(true)
    expect(promotionApplies(r, ctx({ dates: week.slice(0, 2) }))).toBe(false)
    // ties: the later date is the free one
    expect(discountedNets(deal({ kind: 'EVERY_NTH_FREE', minNights: 2 }), [5000n, 5000n], ['2026-11-10', '2026-11-11'])).toEqual([5000n, 0n])
  })

  it('FIXED_OFF per night takes the amount from each eligible night and stops at one minor unit', () => {
    const r = deal({ kind: 'FIXED_OFF' }, { amountMinor: 2500n, currency: 'AED', amountScope: 'PER_NIGHT' })
    expect(discountedNets(r, nets, dates)).toEqual([7500n, 7500n, 7500n])
    expect(discountedNets(r, [2000n, 9000n], ['2026-11-10', '2026-11-11'])).toEqual([1n, 6500n])
  })

  it('FIXED_OFF per stay splits the amount over the eligible nights in integers, the first nights taking the remainder', () => {
    const r = deal({ kind: 'FIXED_OFF' }, { amountMinor: 10000n, currency: 'AED', amountScope: 'PER_STAY' })
    const after = discountedNets(r, nets, dates)
    expect(after).toEqual([6666n, 6667n, 6667n])
    expect(total(nets) - total(after)).toBe(10000n)
  })

  it('FIXED_OFF applies only in its own currency and never to a missing currency', () => {
    const r = deal({ kind: 'FIXED_OFF' }, { amountMinor: 2500n, currency: 'AED', amountScope: 'PER_NIGHT' })
    expect(promotionApplies(r, ctx())).toBe(true)
    expect(promotionApplies(r, ctx({ currency: 'USD' }))).toBe(false)
    expect(promotionApplies(r, ctx({ currency: null }))).toBe(false)
    expect(promotionApplies(r, ctx({ currency: undefined }))).toBe(false)
  })

  it('FIXED_OFF with a room-only base never discounts the guest lines', () => {
    const r = deal({ kind: 'FIXED_OFF', discountBase: 'ROOM_ONLY' }, { amountMinor: 5000n, currency: 'AED', amountScope: 'PER_NIGHT' })
    // room 3000 + guest 4000 = 7000: only the room 3000 may be discounted
    expect(discountedNets(r, [7000n], ['2026-11-10'], [3000n])).toEqual([4000n])
  })
})

describe('day of week and effective window', () => {
  const tueWed = (1 << weekdayBit('2026-11-10')) | (1 << weekdayBit('2026-11-11'))
  it('a weekday list discounts only the nights on those days and needs at least one such night', () => {
    const r = deal({ kind: 'PERCENT_OFF', percentBp: 1000 }, { weekdays: tueWed })
    expect(discountedNets(r, nets, dates)).toEqual([9000n, 9000n, 10000n])
    expect(promotionApplies(r, ctx({ dates: ['2026-11-12'] }))).toBe(false) // a Thursday-only stay
  })

  it('the deal window is judged against the hotel day, inclusive; an unknown day fails closed', () => {
    const r = deal({ kind: 'PERCENT_OFF', percentBp: 1000 }, { activeFrom: '2026-10-12', activeTo: '2026-10-14' })
    expect(promotionApplies(r, ctx({ today: '2026-10-12' }))).toBe(true)
    expect(promotionApplies(r, ctx({ today: '2026-10-14' }))).toBe(true)
    expect(promotionApplies(r, ctx({ today: '2026-10-11' }))).toBe(false)
    expect(promotionApplies(r, ctx({ today: '2026-10-15' }))).toBe(false)
    expect(promotionApplies(r, ctx({ today: null }))).toBe(false)
  })
})

describe('audience: channel, market and agency (allow-lists that fail closed)', () => {
  const base = { kind: 'PERCENT_OFF' as const, percentBp: 1000 }
  it('an unrestricted deal needs no buyer or channel', () => {
    expect(promotionApplies(deal(base), ctx())).toBe(true)
  })
  it('a channel list applies only to a named channel in the list', () => {
    const r = deal(base, { channels: ['PORTAL'] })
    expect(promotionApplies(r, ctx({ channel: 'PORTAL' }))).toBe(true)
    expect(promotionApplies(r, ctx({ channel: 'API' }))).toBe(false)
    expect(promotionApplies(r, ctx({ channel: null }))).toBe(false)
    expect(promotionApplies(r, ctx())).toBe(false)
  })
  it('a market list needs a known buyer market in the list', () => {
    const r = deal(base, { sourceMarkets: ['IN', 'AE'] })
    expect(promotionApplies(r, ctx({ buyer: { market: 'IN', agencyId: null } }))).toBe(true)
    expect(promotionApplies(r, ctx({ buyer: { market: 'GB', agencyId: null } }))).toBe(false)
    expect(promotionApplies(r, ctx({ buyer: { market: null, agencyId: null } }))).toBe(false)
    expect(promotionApplies(r, ctx({ buyer: null }))).toBe(false)
  })
  it('an agency list needs a known agency in the list', () => {
    const r = deal(base, { agencyIds: ['ag1'] })
    expect(promotionApplies(r, ctx({ buyer: { market: 'AE', agencyId: 'ag1' } }))).toBe(true)
    expect(promotionApplies(r, ctx({ buyer: { market: 'AE', agencyId: 'ag2' } }))).toBe(false)
    expect(promotionApplies(r, ctx({ buyer: { market: 'AE', agencyId: null } }))).toBe(false)
  })
  it('every list must hold at once', () => {
    const r = deal(base, { channels: ['PORTAL'], sourceMarkets: ['IN'], agencyIds: ['ag1'] })
    expect(promotionApplies(r, ctx({ channel: 'PORTAL', buyer: { market: 'IN', agencyId: 'ag1' } }))).toBe(true)
    expect(promotionApplies(r, ctx({ channel: 'PORTAL', buyer: { market: 'IN', agencyId: 'ag9' } }))).toBe(false)
  })
})

describe('commercial guards: a breach drops the deal and the base rate stands', () => {
  const pct = { kind: 'PERCENT_OFF' as const, percentBp: 3000 }
  it('a maximum discount refuses a larger saving and allows an equal one', () => {
    expect(selectPromotion([deal(pct, { maxDiscountBp: 2999 })], ctx(), nets)).toBeNull()
    expect(selectPromotion([deal(pct, { maxDiscountBp: 3000 })], ctx(), nets)?.applied.savingMinor).toBe(9000n)
  })

  it('a sell floor is judged on net plus markup of each changed night', () => {
    // net 10000 after 30% = 7000; markup 10% (1000 bp) = 700; sell 7700
    const markups = [1000, 1000, 1000]
    expect(selectPromotion([deal(pct, { minSellFloorMinor: 7700n })], ctx({ markups }), nets)).not.toBeNull()
    expect(selectPromotion([deal(pct, { minSellFloorMinor: 7701n })], ctx({ markups }), nets)).toBeNull()
    // a SELL rate has no markup: the floor applies to the net itself
    expect(selectPromotion([deal(pct, { minSellFloorMinor: 7000n })], ctx({ markups: [null, null, null] }), nets)).not.toBeNull()
    expect(selectPromotion([deal(pct, { minSellFloorMinor: 7001n })], ctx({ markups: [null, null, null] }), nets)).toBeNull()
  })

  it('a guard that cannot be verified is a breach: no markup information, or a margin guard on a SELL rate', () => {
    expect(guardBreach(deal(pct, { minSellFloorMinor: 100n }), nets, [7000n, 7000n, 7000n], {})).toBe('GUARD_UNVERIFIABLE')
    expect(guardBreach(deal(pct, { minMarginBp: 500 }), nets, [7000n, 7000n, 7000n], { markups: [null, null, null] })).toBe('GUARD_UNVERIFIABLE')
  })

  it('a minimum margin is measured on the sell price', () => {
    // 1000 bp markup on 7000 = 700; margin = 700 / 7700 = 909 bp
    const markups = [1000, 1000, 1000]
    expect(guardBreach(deal(pct, { minMarginBp: 909 }), nets, [7000n, 7000n, 7000n], { markups })).toBeNull()
    expect(guardBreach(deal(pct, { minMarginBp: 910 }), nets, [7000n, 7000n, 7000n], { markups })).toBe('MARGIN_BELOW_MINIMUM')
  })

  it('only the nights the deal changed are judged', () => {
    const r = deal({ kind: 'PERCENT_OFF', percentBp: 3000 }, { minSellFloorMinor: 8000n })
    // the weekday list leaves nights 1 and 3 at 10000; only night 2 falls to 7000 (below 8000), so the guard still trips
    const tueOnly = { ...r, deal: { ...r.deal!, weekdays: 1 << weekdayBit('2026-11-11') } }
    expect(selectPromotion([tueOnly], ctx({ markups: [null, null, null] }), nets)).toBeNull()
  })

  it('priority never overrides a guard, and a guarded deal is reported with the guard that stopped it', () => {
    const guarded = deal({ kind: 'PERCENT_OFF', percentBp: 5000, id: 'guarded' }, { maxDiscountBp: 1000, priority: 100 })
    const plain = deal({ kind: 'PERCENT_OFF', percentBp: 500, id: 'plain' })
    const out = evaluatePromotions([guarded, plain], ctx(), nets)
    expect(out.selected?.applied.id).toBe('plain')
    expect(out.considered.find((entry) => entry.id === 'guarded')).toMatchObject({ outcome: 'GUARD_BREACHED', guard: 'MAX_DISCOUNT_EXCEEDED' })
  })
})

describe('selection, priority and stacking exclusions', () => {
  it('the larger saving wins whatever the priority', () => {
    const big = deal({ kind: 'PERCENT_OFF', percentBp: 2000, id: 'big' }, { priority: 0 })
    const small = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'small' }, { priority: 100 })
    expect(selectPromotion([small, big], ctx(), nets)?.applied.id).toBe('big')
  })
  it('equal savings go to the higher priority, then the lower id', () => {
    const a = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'a' }, { priority: 1 })
    const b = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'b' }, { priority: 5 })
    expect(selectPromotion([a, b], ctx(), nets)?.applied.id).toBe('b')
    const c = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'c' }, { priority: 5 })
    expect(selectPromotion([c, b], ctx(), nets)?.applied.id).toBe('b')
  })
  it('the same promotion id is applied once', () => {
    const a = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'a' })
    expect(selectPromotion([a, a, a], ctx(), nets)?.applied.savingMinor).toBe(3000n)
    expect(selectPromotion([{ ...a, combinable: true }, { ...a, combinable: true }], ctx(), nets)?.applied.combined).toBeUndefined()
  })
  it('combinable deals stack when that saves more, in a fixed order', () => {
    const a = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'a', combinable: true })
    const b = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'b', combinable: true })
    const out = selectPromotion([a, b], ctx(), nets)!
    expect(out.applied.combined?.map((m) => m.id)).toEqual(['a', 'b'])
    expect(out.nets).toEqual([8100n, 8100n, 8100n])
  })
  it('deals in the same stacking group never stack', () => {
    const a = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'a', combinable: true }, { stackingGroup: 'SUMMER' })
    const b = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'b', combinable: true }, { stackingGroup: 'SUMMER' })
    const out = evaluatePromotions([a, b], ctx(), nets)
    expect(out.selected?.applied.combined).toBeUndefined()
    expect(out.considered.find((entry) => entry.id === 'b')?.outcome).toBe('EXCLUDED_BY_STACK_RULE')
  })
  it('an explicit exclusion works from either side', () => {
    const a = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'a', combinable: true }, { incompatibleWith: ['b'] })
    const b = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'b', combinable: true })
    expect(selectPromotion([a, b], ctx(), nets)?.applied.combined).toBeUndefined()
    expect(selectPromotion([b, a], ctx(), nets)?.applied.combined).toBeUndefined()
  })
  it('a stack is held to the guards of every deal in it', () => {
    const a = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'a', combinable: true })
    const b = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'b', combinable: true }, { maxDiscountBp: 1500 })
    // alone each saves 10%; together 19%, which b's cap of 15% refuses, so only the better single applies
    const out = selectPromotion([a, b], ctx(), nets)!
    expect(out.applied.combined).toBeUndefined()
    expect(out.applied.savingMinor).toBe(3000n)
  })
  it('a deal and a legacy plan promotion stack when both are combinable', () => {
    const legacy: PromotionRule = { id: 'legacy', kind: 'LONG_STAY', name: 'Long', percentBp: 1000, minLeadDays: null, maxLeadDays: null, minNights: 2, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, combinable: true }
    const d = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'z', combinable: true })
    expect(selectPromotion([legacy, d], ctx(), nets)?.applied.combined?.map((m) => m.id)).toEqual(['legacy', 'z'])
  })
  it('marks every considered rule with its outcome', () => {
    const win = deal({ kind: 'PERCENT_OFF', percentBp: 2000, id: 'win' })
    const lose = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'lose' })
    const off = deal({ kind: 'PERCENT_OFF', percentBp: 1000, id: 'off' }, { channels: ['API'] })
    const none = deal({ kind: 'FIXED_OFF', id: 'none' }, { amountMinor: 1n, currency: 'AED', amountScope: 'PER_NIGHT' })
    const outcomes = Object.fromEntries(evaluatePromotions([win, lose, off, { ...none, minNights: 9 }], ctx(), nets).considered.map((entry) => [entry.id, entry.outcome]))
    expect(outcomes).toEqual({ win: 'APPLIED', lose: 'OUTRANKED', off: 'NOT_ELIGIBLE', none: 'NOT_ELIGIBLE' })
  })
})

describe('the deal inside the one stay evaluator', () => {
  const request = { checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 2, adults: 2, children: 0, currency: 'AED', now: new Date('2026-10-05T00:00:00.000Z'), channel: 'PORTAL' as string | null, buyer: { nationality: 'AE', market: 'IN', agencyId: 'ag1' } }
  const night = (date: string, patch: Partial<ContractedStaySnapshot['nights'][number]> = {}): ContractedStaySnapshot['nights'][number] => ({ date, rateAmountMinor: 10000n, rateCurrency: 'AED', amountBasis: 'NET', markupBasisPoints: 1000, availability: { allotment: 4, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false }, ...patch })
  const snapshot = (promotions: PromotionRule[], patch: Partial<ContractedStaySnapshot> = {}): ContractedStaySnapshot => ({
    hotelContentStatus: 'COMPLETE', roomActive: true, boardActive: true, supplierStatus: 'ACTIVE', hotelMappingStatus: 'MAPPED', hotelMappingHotelId: 'h', canonicalHotelId: 'h', roomMappingStatus: 'MAPPED', contractStatus: 'ACTIVE',
    contractValidFrom: '2026-10-01', contractValidTo: '2026-12-31', contractCurrency: 'AED', guestPrices: [], promotions, derivedProblem: null, cancellationPolicyMissing: false, leadTimeRule: null, minStayMode: 'STAY_THROUGH', supplements: [], eventSupplements: [],
    planMarketRules: { salesMarkets: [], nationalities: [] }, ratePlanValidFrom: null, ratePlanValidTo: null, ratePlanStatus: 'ACTIVE', ratePlanOccupancy: 2, ratePlanCurrency: 'AED', ratePlanMinStay: 1, ratePlanMaxStay: 14, ratePlanReleaseDays: 0,
    ratePlanReleaseTimeLocal: '00:00', hotelTimeZone: 'Asia/Dubai', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, nights: [night('2026-10-15'), night('2026-10-16'), night('2026-10-17')], ...patch,
  })

  it('discounts the supplier net, then applies the markup on what is left, for every room', () => {
    // 3 nights x 10000 net, 20% deal -> 8000 net, 10% markup -> 8800 sell; 2 rooms
    const out = evaluateContractedStay(snapshot([deal({ kind: 'PERCENT_OFF', percentBp: 2000 })]), request)
    expect(out).toMatchObject({ eligible: true, netMinor: 48000n, totalMinor: 52800n, markupMinor: 4800n })
    expect(out.promotion).toMatchObject({ id: 'd1', source: 'DEAL', savingMinor: 6000n, rooms: 2 })
  })

  it('without the deal the same stay costs the full rate', () => {
    expect(evaluateContractedStay(snapshot([]), request)).toMatchObject({ eligible: true, netMinor: 60000n, totalMinor: 66000n, promotion: null })
  })

  it('a deal that does not match the buyer or channel leaves the base price: never a fabricated discount', () => {
    const restricted = deal({ kind: 'PERCENT_OFF', percentBp: 2000 }, { sourceMarkets: ['GB'] })
    expect(evaluateContractedStay(snapshot([restricted]), request)).toMatchObject({ eligible: true, totalMinor: 66000n, promotion: null })
    expect(evaluateContractedStay(snapshot([deal({ kind: 'PERCENT_OFF', percentBp: 2000 }, { channels: ['PORTAL'] })]), { ...request, channel: null })).toMatchObject({ totalMinor: 66000n, promotion: null })
    expect(evaluateContractedStay(snapshot([deal({ kind: 'PERCENT_OFF', percentBp: 2000 }, { channels: ['PORTAL'] })]), request)).toMatchObject({ totalMinor: 52800n })
  })

  it('a sell floor judged with the real markup keeps the base price when it would be breached', () => {
    const floor = deal({ kind: 'PERCENT_OFF', percentBp: 2000 }, { minSellFloorMinor: 8801n })
    expect(evaluateContractedStay(snapshot([floor]), request)).toMatchObject({ totalMinor: 66000n, promotion: null })
    expect(evaluateContractedStay(snapshot([{ ...floor, deal: { ...floor.deal!, minSellFloorMinor: 8800n } }]), request)).toMatchObject({ totalMinor: 52800n })
  })

  it('a SELL-basis rate under a margin guard keeps the base price (no supplier net is known)', () => {
    const r = deal({ kind: 'PERCENT_OFF', percentBp: 1000 }, { minMarginBp: 100 })
    const sell = snapshot([r], { nights: [night('2026-10-15', { amountBasis: 'SELL', markupBasisPoints: null }), night('2026-10-16', { amountBasis: 'SELL', markupBasisPoints: null }), night('2026-10-17', { amountBasis: 'SELL', markupBasisPoints: null })] })
    expect(evaluateContractedStay(sell, request)).toMatchObject({ eligible: true, totalMinor: 60000n, promotion: null })
  })

  it('a stay the base rate cannot sell stays unsellable: the deal never rescues it', () => {
    const out = evaluateContractedStay(snapshot([deal({ kind: 'PERCENT_OFF', percentBp: 2000 })], { ratePlanStatus: 'SUSPENDED' }), request)
    expect(out).toMatchObject({ eligible: false, totalMinor: null, promotion: null })
    expect(out.reasons).toContain('RATE_PLAN_INACTIVE')
  })

  it('FIXED_OFF applies only in the plan currency, judged by the evaluator', () => {
    const fixed = deal({ kind: 'FIXED_OFF' }, { amountMinor: 1000n, currency: 'USD', amountScope: 'PER_NIGHT' })
    expect(evaluateContractedStay(snapshot([fixed]), request)).toMatchObject({ totalMinor: 66000n, promotion: null })
    const aed = deal({ kind: 'FIXED_OFF' }, { amountMinor: 1000n, currency: 'AED', amountScope: 'PER_NIGHT' })
    expect(evaluateContractedStay(snapshot([aed]), request)).toMatchObject({ netMinor: 54000n, totalMinor: 59400n })
  })

  it('reports the nightly breakdown and the trace only when asked, so other callers keep their shape', () => {
    const r = deal({ kind: 'PERCENT_OFF', percentBp: 2000 })
    const plain = evaluateContractedStay(snapshot([r]), request)
    expect('nightly' in plain || 'promotionTrace' in plain).toBe(false)
    const detailed = evaluateContractedStay(snapshot([r]), { ...request, detail: true })
    expect(detailed.nightly).toEqual([
      { date: '2026-10-15', netBeforeMinor: 10000n, promotionMinor: 2000n, supplementMinor: 0n, netMinor: 8000n, markupMinor: 800n, sellMinor: 8800n },
      { date: '2026-10-16', netBeforeMinor: 10000n, promotionMinor: 2000n, supplementMinor: 0n, netMinor: 8000n, markupMinor: 800n, sellMinor: 8800n },
      { date: '2026-10-17', netBeforeMinor: 10000n, promotionMinor: 2000n, supplementMinor: 0n, netMinor: 8000n, markupMinor: 800n, sellMinor: 8800n },
    ])
    expect(detailed.promotionTrace).toEqual([{ id: 'd1', name: 'Deal', outcome: 'APPLIED', savingMinor: 6000n }])
  })
})
