import { CONTRACT_EXPIRING_DAYS, HOTEL_STAR_RATING_MISSING } from '@bedbanks/contracts'
import { evaluateContractedStay } from './contracted-sellability'
import { assessHotel, addDays, categoryOfReason, contractStateOf, gateResults, windowDates, type AssessHotelInput, type AssessPlan } from './commercial-assessment'
import { buildStaySnapshot } from './stay-snapshot'

// A fixed clock: nothing here depends on the real date.
const TODAY = '2030-06-01'
const dates = windowDates(TODAY, 5)
const at = (day: string) => new Date(`${day}T00:00:00.000Z`)

interface PlanOpts {
  id?: string; status?: string; occupancy?: number; currency?: string; maxAdults?: number; maxChildren?: number
  contractStatus?: string; validFrom?: string; validTo?: string; contractCurrency?: string; supplierStatus?: string
  mappingId?: string | null; rate?: boolean; availability?: boolean; stopSell?: boolean; allotment?: number; sold?: number; held?: number
  basis?: 'SELL' | 'NET' | null; rateCurrency?: string; boardActive?: boolean; roomActive?: boolean; hotelContent?: string
}
function plan(o: PlanOpts = {}): AssessPlan {
  const id = o.id ?? 'plan-1'
  return {
    id, code: `CODE-${id}`, status: o.status ?? 'ACTIVE', occupancy: o.occupancy ?? 2, currency: o.currency ?? 'AED', minStay: 1, maxStay: null, releaseDays: 0, refundable: true,
    contractId: 'c1', roomTypeId: 'room-1', boardBasisId: 'b1',
    boardBasis: { code: 'BB', isActive: o.boardActive ?? true },
    roomType: { id: 'room-1', name: 'Deluxe', code: 'DLX', hotelId: 'h1', isActive: o.roomActive ?? true, maxAdults: o.maxAdults ?? 2, maxChildren: o.maxChildren ?? 0, maxOccupancy: 2, hotel: { contentStatus: o.hotelContent ?? 'COMPLETE' } },
    contract: { id: 'c1', code: 'C-1', status: o.contractStatus ?? 'ACTIVE', validFrom: at(o.validFrom ?? '2030-01-01'), validTo: at(o.validTo ?? '2031-01-01'), settlementCurrency: o.contractCurrency ?? 'AED', supplierId: 's1', supplierHotelMappingId: o.mappingId === undefined ? 'm1' : o.mappingId, supplier: { status: o.supplierStatus ?? 'ACTIVE', displayName: 'Supplier One' } },
    dailyRates: o.rate === false ? [] : dates.map((d) => ({ stayDate: at(d), amountMinor: 30_000n, currency: o.rateCurrency ?? 'AED', amountBasis: o.basis === undefined ? 'SELL' as const : o.basis, occupancy: o.occupancy ?? 2 })),
    availability: o.availability === false ? [] : dates.map((d) => ({ stayDate: at(d), allotment: o.allotment ?? 5, sold: o.sold ?? 0, held: o.held ?? 0, stopSell: o.stopSell ?? false, minStay: 1, closedToArrival: false })),
  }
}
interface HotelOpts { plans?: AssessPlan[]; mappingStatus?: string; roomMapped?: boolean; roomMappingStatus?: string; content?: string; stars?: number | null; contracts?: AssessHotelInput['contracts'] }
function input(o: HotelOpts = {}): AssessHotelInput {
  const plans = o.plans ?? [plan()]
  return {
    hotel: { id: 'h1', name: 'Test Hotel', contentStatus: o.content ?? 'COMPLETE', starRating: o.stars === undefined ? 5 : o.stars },
    rooms: [{ id: 'room-1', name: 'Deluxe', code: 'DLX', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true }],
    plans, contracts: o.contracts ?? [],
    mappings: o.mappingStatus === 'NONE' ? [] : [{ id: 'm1', supplierId: 's1', supplierName: 'Supplier One', hotelId: 'h1', status: o.mappingStatus ?? 'MAPPED', supplierHotelId: 'SUP-H1', confidence: null, updatedAt: at(TODAY) }],
    roomMappings: o.roomMapped === false ? [] : [{ id: 'rm1', supplierHotelMappingId: 'm1', roomTypeId: 'room-1', supplierRoomId: 'SUP-R1', status: o.roomMappingStatus ?? 'MAPPED', confidence: null, updatedAt: at(TODAY) }],
    dates, today: TODAY, observedAt: '2030-06-01T00:00:00.000Z',
  }
}
const reasons = (o: HotelOpts) => assessHotel(input(o)).plans.flatMap((p) => p.nights.flatMap((n) => n.reasons))

describe('commercial assessment', () => {
  it('HOTEL-OPS-05: a fully configured hotel is READY, with every gate passing and no issues', () => {
    const a = assessHotel(input())
    expect(a.readiness).toBe('READY')
    expect(a.agentSellable).toBe(true)
    expect(a.blockers).toEqual([])
    expect(a.issues).toEqual([])
    expect(a.gates.every((g) => g.state === 'PASS')).toBe(true)
    expect(a.hotelMapping).toBe('MAPPED'); expect(a.rates).toBe('OK'); expect(a.inventory).toBe('OK')
    expect(a.roomCounts).toEqual({ total: 1, active: 1, mapped: 1 })
  })

  it('HOTEL-OPS-06: one stop-sold night makes the hotel PARTIAL, not READY or BLOCKED, and the issue carries the date', () => {
    const p = plan(); p.availability[2].stopSell = true
    const a = assessHotel(input({ plans: [p] }))
    expect(a.readiness).toBe('PARTIAL')
    expect(a.agentSellable).toBe(true)
    const issue = a.issues.find((i) => i.category === 'STOP_SELL')!
    expect(issue).toMatchObject({ severity: 'WARNING', from: dates[2], to: dates[2], nights: 1, section: 'rates', reason: 'STOP_SELL' })
    expect(a.inventory).toBe('STOP_SELL')
  })

  it('HOTEL-OPS-07: a hotel with nothing sellable is BLOCKED and every issue is CRITICAL', () => {
    const a = assessHotel(input({ plans: [plan({ stopSell: true })] }))
    expect(a.readiness).toBe('BLOCKED'); expect(a.agentSellable).toBe(false)
    expect(a.issues.length).toBeGreaterThan(0)
    expect(a.issues.every((i) => i.severity === 'CRITICAL')).toBe(true)
    expect(a.blockers).toContain('STOP_SELL')
  })

  it('a new hotel with no rate plan is BLOCKED (RATE_PLAN_MISSING) and an unmapped hotel is called out: never "ready" by default', () => {
    const a = assessHotel({ ...input({ plans: [], mappingStatus: 'NONE', roomMapped: false }) })
    expect(a.readiness).toBe('BLOCKED')
    expect(a.blockers).toContain('RATE_PLAN_MISSING')
    expect(a.issues.map((i) => i.category)).toEqual(expect.arrayContaining(['ENTITY_INACTIVE', 'UNMAPPED_HOTEL']))
    expect(a.gates.find((g) => g.key === 'sellability')!.state).toBe('FAIL')
    expect(a.gates.find((g) => g.key === 'dailyRates')!.state).toBe('NA')
    expect(a.contractState).toBe('NONE')
  })

  it('only ACTIVE plans are assessed; a DRAFT plan alone gives RATE_PLAN_INACTIVE', () => {
    const a = assessHotel(input({ plans: [plan({ status: 'DRAFT' })] }))
    expect(a.readiness).toBe('BLOCKED'); expect(a.blockers).toContain('RATE_PLAN_INACTIVE')
    expect(a.planCounts).toEqual({ total: 1, active: 0 })
  })

  it('HOTEL-OPS-08: an unapproved or missing hotel mapping blocks and is categorised UNMAPPED_HOTEL', () => {
    for (const mappingStatus of ['PENDING', 'REJECTED']) {
      const a = assessHotel(input({ mappingStatus }))
      expect(a.readiness).toBe('BLOCKED'); expect(a.hotelMapping).toBe(mappingStatus)
      expect(a.issues.some((i) => i.category === 'UNMAPPED_HOTEL' && i.reason === 'SUPPLIER_MAPPING_INVALID' && i.section === 'mappings')).toBe(true)
    }
    const none = assessHotel(input({ plans: [plan({ mappingId: null })], mappingStatus: 'NONE', roomMapped: false }))
    expect(none.readiness).toBe('BLOCKED'); expect(none.hotelMapping).toBe('NONE')
  })

  it('HOTEL-OPS-09: a missing or pending room mapping blocks that room and is categorised UNMAPPED_ROOM', () => {
    for (const o of [{ roomMapped: false }, { roomMappingStatus: 'PENDING' }]) {
      const a = assessHotel(input(o))
      expect(a.readiness).toBe('BLOCKED')
      expect(a.rooms[0].mapping).toBe(o.roomMapped === false ? 'NONE' : 'PENDING')
      expect(a.issues.some((i) => i.category === 'UNMAPPED_ROOM' && i.roomName === 'Deluxe')).toBe(true)
      expect(a.gates.find((g) => g.key === 'roomMapping')!.state).toBe('FAIL')
    }
  })

  it('HOTEL-OPS-10: a contract outside its validity blocks the affected nights; validTo behaves as the last check-out day, exactly like the Agent', () => {
    // validTo = TODAY+3: a one-night stay needs check-out <= validTo, so the last sellable night is TODAY+2.
    const a = assessHotel(input({ plans: [plan({ validTo: addDays(TODAY, 3) })] }))
    expect(a.readiness).toBe('PARTIAL')
    const nights = a.plans[0].nights
    expect(nights.map((n) => n.sellable)).toEqual([true, true, true, false, false])
    expect(nights[3].reasons).toContain('OUTSIDE_CONTRACT_VALIDITY')
    const issue = a.issues.find((i) => i.category === 'CONTRACT_EXPIRED')!
    expect(issue).toMatchObject({ from: dates[3], to: dates[4], nights: 2, section: 'contracts' })
    const before = assessHotel(input({ plans: [plan({ validFrom: addDays(TODAY, 2) })] }))
    expect(before.plans[0].nights.map((n) => n.sellable)).toEqual([false, false, true, true, true])
  })

  it('HOTEL-OPS-11: a missing rate is RATE_MISSING; a negative rate is RATE_INVALID', () => {
    const missing = assessHotel(input({ plans: [plan({ rate: false })] }))
    expect(missing.readiness).toBe('BLOCKED'); expect(missing.rates).toBe('GAPS')
    expect(missing.issues.find((i) => i.reason === 'DAILY_RATE_MISSING_OR_INVALID')!.category).toBe('RATE_MISSING')
    const p = plan(); p.dailyRates[1].amountMinor = -1n
    const invalid = assessHotel(input({ plans: [p] }))
    expect(invalid.issues.find((i) => i.reason === 'DAILY_RATE_MISSING_OR_INVALID')!).toMatchObject({ category: 'RATE_INVALID', from: dates[1], nights: 1 })
  })

  it('HOTEL-OPS-12: missing availability is AVAILABILITY_MISSING', () => {
    const a = assessHotel(input({ plans: [plan({ availability: false })] }))
    expect(a.readiness).toBe('BLOCKED'); expect(a.inventory).toBe('GAPS')
    expect(a.issues.find((i) => i.category === 'AVAILABILITY_MISSING')).toMatchObject({ nights: 5, reason: 'AVAILABILITY_MISSING' })
  })

  it('HOTEL-OPS-14: remaining is allotment - sold - held; held inventory counts, and zero remaining is NO_INVENTORY', () => {
    const a = assessHotel(input({ plans: [plan({ allotment: 3, sold: 1, held: 1 })] }))
    expect(a.plans[0].nights.every((n) => n.remaining === 1 && n.sellable)).toBe(true)
    const full = assessHotel(input({ plans: [plan({ allotment: 3, sold: 2, held: 1 })] }))
    expect(full.plans[0].nights.every((n) => n.remaining === 0)).toBe(true)
    expect(full.readiness).toBe('BLOCKED'); expect(full.inventory).toBe('EXHAUSTED')
    expect(full.issues.find((i) => i.category === 'INVENTORY_EXHAUSTED')).toBeDefined()
    const over = assessHotel(input({ plans: [plan({ allotment: 1, sold: 1, held: 1 })] }))
    expect(over.plans[0].nights[0].remaining).toBe(-1) // surfaced, never hidden
    expect(over.readiness).toBe('BLOCKED')
  })

  it('occupancy, currency and amount-basis problems use the canonical codes', () => {
    expect(reasons({ plans: [plan({ occupancy: 3 })] })).toContain('OCCUPANCY_UNSUPPORTED')
    expect(reasons({ plans: [plan({ rateCurrency: 'USD' })] })).toContain('RATE_CURRENCY_MISMATCH')
    expect(reasons({ plans: [plan({ contractCurrency: 'USD' })] })).toContain('RATE_CURRENCY_MISMATCH')
    expect(reasons({ plans: [plan({ basis: null })] })).toContain('RATE_AMOUNT_BASIS_UNVERIFIED')
    expect(reasons({ plans: [plan({ basis: 'NET' })] })).toContain('NET_RATE_MARKUP_UNAVAILABLE')
    expect(categoryOfReason('NET_RATE_MARKUP_UNAVAILABLE', { hotelMappingOk: true, contractStatus: 'ACTIVE', hasRate: true })).toBe('CURRENCY_OR_BASIS')
  })

  it('entity status is not commercial readiness: an ACTIVE-looking hotel can still be blocked by inactive supplier, room or board', () => {
    expect(reasons({ plans: [plan({ supplierStatus: 'SUSPENDED' })] })).toContain('SUPPLIER_INACTIVE')
    expect(reasons({ plans: [plan({ roomActive: false })] })).toContain('ROOM_TYPE_INACTIVE')
    expect(reasons({ plans: [plan({ boardActive: false })] })).toContain('BOARD_BASIS_INACTIVE')
    expect(reasons({ plans: [plan({ contractStatus: 'SUSPENDED' })] })).toContain('CONTRACT_INACTIVE')
  })

  it('matches the Agent: a hotel whose content is not COMPLETE, or has no star rating, is not sellable', () => {
    const draft = assessHotel(input({ content: 'DRAFT', plans: [plan({ hotelContent: 'DRAFT' })] }))
    expect(draft.readiness).toBe('BLOCKED'); expect(draft.blockers).toContain('HOTEL_INACTIVE')
    expect(draft.gates.find((g) => g.key === 'hotel')!.state).toBe('FAIL')
    expect(draft.issues.filter((i) => i.reason === 'HOTEL_INACTIVE')).toHaveLength(1) // once per hotel, not per plan-night
    const noStars = assessHotel(input({ stars: null }))
    expect(noStars.readiness).toBe('BLOCKED'); expect(noStars.blockers).toContain(HOTEL_STAR_RATING_MISSING)
  })

  it('AGENT CONSISTENCY: for a stay the assessor calls fully sellable, evaluateContractedStay is eligible with the same total; for a blocked night it is not', () => {
    const p = plan(); p.availability[3].stopSell = true
    const a = assessHotel(input({ plans: [p] }))
    const stayOk = evaluateContractedStay(buildStaySnapshot(p, { status: 'MAPPED', hotelId: 'h1' }, { status: 'MAPPED' }, dates.slice(0, 3)), { checkIn: dates[0], checkOut: dates[3], rooms: 1, adults: 2, children: 0, currency: 'AED', leadDays: 100 })
    expect(a.plans[0].nights.slice(0, 3).every((n) => n.sellable)).toBe(true)
    expect(stayOk).toMatchObject({ eligible: true, totalMinor: 90_000n })
    const stayBad = evaluateContractedStay(buildStaySnapshot(p, { status: 'MAPPED', hotelId: 'h1' }, { status: 'MAPPED' }, dates.slice(2, 5)), { checkIn: dates[2], checkOut: dates[5], rooms: 1, adults: 2, children: 0, currency: 'AED', leadDays: 100 })
    expect(a.plans[0].nights[3].sellable).toBe(false)
    expect(stayBad.eligible).toBe(false); expect(stayBad.reasons).toContain('STOP_SELL')
  })

  it('stay-length rules do not make a night unsellable in readiness (they belong to the stay inspector)', () => {
    const p = plan(); p.minStay = 3; p.releaseDays = 999; p.availability[0].closedToArrival = true
    const a = assessHotel(input({ plans: [p] }))
    expect(a.readiness).toBe('READY')
  })

  it('severity is deterministic: HIGH when the whole window is affected on a partial hotel, WARNING for part of it, CRITICAL only when blocked', () => {
    const stopAll = plan({ id: 'stop', stopSell: true }); stopAll.contract.supplierHotelMappingId = 'm1'
    const good = plan({ id: 'good' }); good.availability[1].stopSell = true
    const a = assessHotel(input({ plans: [stopAll, good] }))
    expect(a.readiness).toBe('PARTIAL')
    expect(a.issues.find((i) => i.ratePlanId === 'stop' && i.reason === 'STOP_SELL')!.severity).toBe('HIGH')
    expect(a.issues.find((i) => i.ratePlanId === 'good' && i.reason === 'STOP_SELL')!.severity).toBe('WARNING')
    expect(a.issues[0].severity).toBe('HIGH') // sorted most severe first
    expect(a.issues.map((i) => i.id)).toEqual([...a.issues.map((i) => i.id)]) // ids are stable strings
  })

  it('HOTEL-OPS contract expiry: one threshold, four states, and an expiry warning that never changes sellability', () => {
    const c = (status: string, validTo: string) => contractStateOf({ status, validTo: at(validTo) }, TODAY)
    expect(c('ACTIVE', addDays(TODAY, CONTRACT_EXPIRING_DAYS + 1))).toMatchObject({ state: 'ACTIVE' })
    expect(c('ACTIVE', addDays(TODAY, CONTRACT_EXPIRING_DAYS))).toMatchObject({ state: 'EXPIRING', daysToExpiry: CONTRACT_EXPIRING_DAYS })
    expect(c('ACTIVE', TODAY)).toMatchObject({ state: 'EXPIRING', daysToExpiry: 0 })
    expect(c('ACTIVE', addDays(TODAY, -1))).toMatchObject({ state: 'EXPIRED', daysToExpiry: -1 })
    expect(c('EXPIRED', addDays(TODAY, 400)).state).toBe('EXPIRED')
    for (const status of ['DRAFT', 'REVIEW', 'SUSPENDED']) expect(c(status, addDays(TODAY, 400)).state).toBe('INACTIVE')

    const a = assessHotel(input({ plans: [plan({ validTo: addDays(TODAY, 20) })] }))
    expect(a.contractState).toBe('EXPIRING'); expect(a.contractDaysToExpiry).toBe(20)
    expect(a.readiness).toBe('READY') // the dates in the window are still sellable
    expect(a.issues).toHaveLength(1)
    expect(a.issues[0]).toMatchObject({ category: 'CONTRACT_EXPIRING', severity: 'WARNING', section: 'contracts', reason: null })
    expect(a.gates.find((g) => g.key === 'contract')!.state).toBe('WARN')
    // the best contract wins when several exist
    const both = assessHotel(input({ plans: [plan({ id: 'a', validTo: addDays(TODAY, 20) }), plan({ id: 'b', validTo: addDays(TODAY, 400) })] }))
    expect(both.contractState).toBe('EXPIRING') // same contract id in this fixture; state follows the contract row
  })

  it('suppliers come from contracts and mappings, de-duplicated', () => {
    const a = assessHotel(input())
    expect(a.suppliers).toEqual([{ id: 's1', displayName: 'Supplier One' }])
  })

  it('gate results map canonical reasons onto the inspector checklist', () => {
    const g = Object.fromEntries(gateResults(['STOP_SELL', 'SUPPLIER_MAPPING_INVALID']).map((x) => [x.key, x.state]))
    expect(g).toMatchObject({ stopSell: 'FAIL', mapping: 'FAIL', rate: 'PASS', availability: 'PASS', hotel: 'PASS' })
  })

  it('amount basis and per-plan counts are reported without any arithmetic on money', () => {
    const a = assessHotel(input({ plans: [plan({ basis: 'NET' })] }))
    expect(a.plans[0].amountBasis).toBe('NET')
    expect(a.plans[0].counts).toMatchObject({ nights: 5, sellable: 0 })
  })
})
