import type { HotelCompleteness, HotelReadinessCriteria } from '@bedbanks/contracts'
import { windowDates, type AssessHotelInput, type AssessPlan } from './commercial-assessment'
import { assessReadiness, type AgencyEvidence, type ReadinessInput } from './hotel-readiness'

// A fixed clock: nothing here depends on the real date.
const TODAY = '2030-06-01'
const NOW = new Date('2030-05-20T08:00:00.000Z')
const dates = windowDates(TODAY, 5)
const at = (day: string) => new Date(`${day}T00:00:00.000Z`)

interface PlanOpts { id?: string; supplierId?: string; occupancy?: number; rate?: boolean; availability?: boolean; mode?: string; mappingId?: string | null; nationalities?: string[]; salesMarkets?: string[]; basis?: 'SELL' | 'NET' | null; status?: string }
function plan(o: PlanOpts = {}): AssessPlan {
  const id = o.id ?? 'plan-1'; const supplierId = o.supplierId ?? 's1'
  return {
    id, code: `CODE-${id}`, status: o.status ?? 'ACTIVE', occupancy: o.occupancy ?? 2, currency: 'AED', minStay: 1, maxStay: null, releaseDays: 0, refundable: true, contractId: `c-${id}`, roomTypeId: 'room-1', boardBasisId: 'b1',
    boardBasis: { code: 'BB', isActive: true },
    roomType: { id: 'room-1', name: 'Deluxe', code: 'DLX', hotelId: 'h1', isActive: true, maxAdults: 2, maxChildren: 1, maxOccupancy: 3, hotel: { contentStatus: 'COMPLETE', timeZone: 'Asia/Dubai' } },
    contract: { id: `c-${id}`, code: `C-${id}`, status: 'ACTIVE', validFrom: at('2030-01-01'), validTo: at('2031-01-01'), settlementCurrency: 'AED', supplierId, supplierHotelMappingId: o.mappingId === undefined ? 'm1' : o.mappingId, supplier: { status: 'ACTIVE', displayName: `Supplier ${supplierId}` }, nationalities: o.nationalities, salesMarkets: o.salesMarkets },
    dailyRates: o.rate === false ? [] : dates.map((d) => ({ stayDate: at(d), amountMinor: 30_000n, currency: 'AED', amountBasis: o.basis === undefined ? 'SELL' as const : o.basis, occupancy: o.occupancy ?? 2 })),
    availability: o.availability === false ? [] : dates.map((d) => ({ stayDate: at(d), allotment: 5, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false, inventoryMode: o.mode })),
  }
}
const assess = (o: { plans?: AssessPlan[]; mappingStatus?: string; stars?: number | null; content?: string } = {}): AssessHotelInput => ({
  hotel: { id: 'h1', name: 'Test Hotel', contentStatus: o.content ?? 'COMPLETE', starRating: o.stars === undefined ? 5 : o.stars },
  rooms: [{ id: 'room-1', name: 'Deluxe', code: 'DLX', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, isActive: true }],
  plans: o.plans ?? [plan()], contracts: [],
  mappings: [{ id: 'm1', supplierId: 's1', supplierName: 'Supplier s1', hotelId: 'h1', status: o.mappingStatus ?? 'MAPPED', supplierHotelId: 'SUP-H1', confidence: null, updatedAt: at(TODAY) }],
  roomMappings: [{ id: 'rm1', supplierHotelMappingId: 'm1', roomTypeId: 'room-1', supplierRoomId: 'SUP-R1', status: 'MAPPED', confidence: null, updatedAt: at(TODAY) }],
  dates, today: TODAY, observedAt: NOW.toISOString(),
})
const completeContent: HotelCompleteness = { requirements: [], met: 12, total: 12, percent: 100, publishable: true }
const criteria = (o: Partial<HotelReadinessCriteria> = {}): HotelReadinessCriteria => ({ checkIn: TODAY, checkOut: '2030-06-06', nights: 5, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'GB', agencyId: null, market: null, currency: 'AED', ...o })
const run = (o: Partial<ReadinessInput> & { c?: Partial<HotelReadinessCriteria> } = {}) => assessReadiness({ criteria: criteria(o.c), now: NOW, assess: o.assess ?? assess(), content: o.content === undefined ? completeContent : o.content, agency: o.agency === undefined ? null : o.agency, supplierNames: new Map([['s1', 'Supplier s1'], ['s2', 'Supplier s2']]) })
const gate = (a: ReturnType<typeof run>, id: string) => a.gates.find((g) => g.gate === id)!
const agency = (o: Partial<AgencyEvidence> = {}): AgencyEvidence => ({ id: 'ag1', name: 'Gulf Travel', status: 'ACTIVE', hotelRestricted: false, restrictedSupplierIds: [], ...o })

describe('unified hotel readiness (explicit criteria)', () => {
  it('HR-01: exposes the seven gates, each with timestamp, applied criteria and no action when it passes', () => {
    const a = run({ agency: agency() })
    expect(a.gates.map((g) => g.gate)).toEqual(['CONTENT', 'MAPPING', 'CONTRACT', 'RATE', 'INVENTORY', 'DISTRIBUTION', 'SEARCH_RECHECK_EVIDENCE'])
    for (const g of a.gates) { expect(g.evaluatedAt).toBe(NOW.toISOString()); expect(g.criteriaApplied.length).toBeGreaterThan(0) }
    for (const id of ['CONTENT', 'MAPPING', 'CONTRACT', 'RATE', 'INVENTORY', 'DISTRIBUTION']) { expect(gate(a, id).outcome).toBe('PASS'); expect(gate(a, id).action).toBeNull() }
    expect(a.commercialVerdict).toBe('PASS'); expect(a.predictedOffers).toBe(1)
  })

  it('HR-02: search/recheck evidence is UNKNOWN even when offers are predicted; a prediction is not evidence', () => {
    const a = run({ agency: agency() })
    expect(a.predictedOffers).toBe(1)
    const e = gate(a, 'SEARCH_RECHECK_EVIDENCE')
    expect(e.outcome).toBe('UNKNOWN'); expect(e.reason).toMatch(/not evidence/)
    expect(e.action?.tab).toBe('sellability')
  })

  it('HR-03: an unreadable profile is UNKNOWN, never FAIL, and the verdict is UNKNOWN rather than FAIL', () => {
    const a = run({ content: null })
    expect(gate(a, 'CONTENT').outcome).toBe('UNKNOWN'); expect(gate(a, 'CONTENT').blockers).toEqual([])
    expect(a.commercialVerdict).toBe('UNKNOWN')
  })

  it('HR-04: unmet publication requirements fail CONTENT with one blocker each and an action to the right tab', () => {
    const content: HotelCompleteness = { ...completeContent, publishable: false, requirements: [{ key: 'ACTIVE_ROOM', label: 'Active room', section: 'rooms', met: false, detail: 'Add a room' }, { key: 'NAME', label: 'Name', section: 'identity', met: true, detail: 'Met.' }] }
    const g = gate(run({ content }), 'CONTENT')
    expect(g.outcome).toBe('FAIL'); expect(g.blockers.map((b) => b.code)).toEqual(['ACTIVE_ROOM']); expect(g.action?.tab).toBe('rooms')
  })

  it('HR-05: content readiness is separate from publication: a complete DRAFT passes CONTENT but fails DISTRIBUTION', () => {
    const a = run({ assess: assess({ content: 'DRAFT' }) })
    expect(gate(a, 'CONTENT').outcome).toBe('PASS')
    expect(gate(a, 'DISTRIBUTION').outcome).toBe('FAIL'); expect(gate(a, 'DISTRIBUTION').blockers[0].code).toBe('HOTEL_INACTIVE')
    expect(a.predictedOffers).toBe(0)
  })

  it('HR-06: a missing rate is a RATE failure (unknown price), not zero, and does not fail inventory', () => {
    const a = run({ assess: assess({ plans: [plan({ rate: false })] }) })
    expect(gate(a, 'RATE').outcome).toBe('FAIL'); expect(gate(a, 'RATE').blockers[0].code).toBe('DAILY_RATE_MISSING_OR_INVALID'); expect(gate(a, 'RATE').action?.tab).toBe('rates')
    expect(gate(a, 'INVENTORY').outcome).toBe('PASS')
    expect(a.commercialVerdict).toBe('FAIL')
  })

  it('HR-07: missing availability is an INVENTORY failure with the canonical reason, never zero stock', () => {
    const g = gate(run({ assess: assess({ plans: [plan({ availability: false })] }) }), 'INVENTORY')
    expect(g.outcome).toBe('FAIL'); expect(g.blockers.map((b) => b.code)).toContain('AVAILABILITY_MISSING')
  })

  it('HR-08: ON_REQUEST is not an offer: INVENTORY fails with ON_REQUEST_ONLY and nothing is predicted', () => {
    const a = run({ assess: assess({ plans: [plan({ mode: 'ON_REQUEST' })] }) })
    expect(gate(a, 'INVENTORY').blockers.map((b) => b.code)).toContain('ON_REQUEST_ONLY'); expect(a.predictedOffers).toBe(0)
  })

  it('HR-09: nationality and market rules are evaluated for the stated buyer and fail closed when it is not supplied', () => {
    const restricted = assess({ plans: [plan({ nationalities: ['IN'], salesMarkets: ['AE'] })] })
    const none = run({ assess: restricted, c: { nationality: null, market: null } })
    expect(gate(none, 'CONTRACT').blockers.map((b) => b.code).sort()).toEqual(['NATIONALITY_NOT_ALLOWED', 'SOURCE_MARKET_NOT_ALLOWED'])
    const wrong = run({ assess: restricted, c: { nationality: 'GB', market: 'AE' } })
    expect(gate(wrong, 'CONTRACT').blockers.map((b) => b.code)).toEqual(['NATIONALITY_NOT_ALLOWED'])
    const right = run({ assess: restricted, c: { nationality: 'IN', market: 'AE' } })
    expect(gate(right, 'CONTRACT').outcome).toBe('PASS'); expect(right.predictedOffers).toBe(1)
  })

  it('HR-10: per-room occupancy is judged against the room and the plan; a mismatch fails CONTRACT', () => {
    const a = run({ c: { adults: 2, children: 1, childAges: [6] } })
    expect(gate(a, 'CONTRACT').blockers.map((b) => b.code)).toContain('OCCUPANCY_UNSUPPORTED')
    expect(a.limitations.join(' ')).toMatch(/Child ages are recorded/)
  })

  it('HR-11: an unapproved mapping fails MAPPING and links to the mappings tab', () => {
    const g = gate(run({ assess: assess({ mappingStatus: 'PENDING' }) }), 'MAPPING')
    expect(g.outcome).toBe('FAIL'); expect(g.blockers[0].code).toBe('SUPPLIER_MAPPING_INVALID'); expect(g.action?.tab).toBe('mappings')
  })

  it('HR-12: agency suspension and restrictions fail DISTRIBUTION and remove the prediction; unreadable agency data is UNKNOWN', () => {
    expect(gate(run({ agency: agency({ status: 'SUSPENDED' }) }), 'DISTRIBUTION').blockers.map((b) => b.code)).toEqual(['AGENCY_SUSPENDED'])
    const hotel = run({ agency: agency({ hotelRestricted: true }) })
    expect(gate(hotel, 'DISTRIBUTION').blockers.map((b) => b.code)).toEqual(['DISTRIBUTION_RESTRICTED_HOTEL']); expect(hotel.predictedOffers).toBe(0)
    const supplier = run({ agency: agency({ restrictedSupplierIds: ['s1'] }) })
    expect(gate(supplier, 'DISTRIBUTION').blockers.map((b) => b.code)).toEqual(['DISTRIBUTION_RESTRICTED_SUPPLIER']); expect(supplier.predictedOffers).toBe(0)
    const unreadable = run({ agency: 'UNREADABLE' })
    expect(gate(unreadable, 'DISTRIBUTION').outcome).toBe('UNKNOWN'); expect(unreadable.predictedOffers).toBe(0); expect(unreadable.commercialVerdict).toBe('UNKNOWN')
  })

  it('HR-13: without an agency the distribution gate says what was not evaluated', () => {
    const g = gate(run(), 'DISTRIBUTION')
    expect(g.outcome).toBe('PASS'); expect(g.criteriaApplied.join(' ')).toMatch(/NOT evaluated/); expect(g.notes.join(' ')).toMatch(/not evaluated/)
  })

  it('HR-14: gates that pass on different plans do not add up to a ready verdict', () => {
    const noRate = plan({ id: 'a', rate: false }); const noStock = plan({ id: 'b', availability: false })
    const a = run({ assess: assess({ plans: [noRate, noStock] }) })
    expect(gate(a, 'RATE').outcome).toBe('PASS'); expect(gate(a, 'INVENTORY').outcome).toBe('PASS')
    expect(a.predictedOffers).toBe(0); expect(a.commercialVerdict).toBe('FAIL'); expect(a.limitations.join(' ')).toMatch(/no single rate plan/)
  })

  it('HR-15: with no rate plan, CONTRACT fails and RATE and INVENTORY are NOT_APPLICABLE with a reason', () => {
    const a = run({ assess: assess({ plans: [] }) })
    expect(gate(a, 'CONTRACT').blockers[0].code).toBe('RATE_PLAN_MISSING')
    for (const id of ['RATE', 'INVENTORY']) { expect(gate(a, id).outcome).toBe('NOT_APPLICABLE'); expect(gate(a, id).reason).toMatch(/No rate plan/) }
  })

  it('HR-16: a PASS carries the criteria it applied and a scope statement, never a universal claim', () => {
    const a = run({ agency: agency() })
    expect(a.scope).toMatch(/stated stay, occupancy, nationality, agency and currency/); expect(a.limitations[0]).toMatch(/does not imply availability on other dates/)
    expect(gate(a, 'CONTRACT').criteriaApplied.join(' ')).toContain('2030-06-01 to 2030-06-06')
  })
})
