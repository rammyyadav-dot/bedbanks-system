import type { SellabilityPlanResult } from '@bedbanks/contracts'
import { buildHotelStayReadiness } from './hotel-stay-readiness'

const plan = (reasons: string[] = [], id = 'plan'): SellabilityPlanResult => ({ ratePlanId: id, ratePlanCode: id, roomTypeId: 'room', roomName: 'Room', boardCode: 'BB', contractCode: 'contract', supplierName: 'Supplier', sellable: reasons.length === 0, reasons, gates: [], nights: [], totalMinor: null, currency: 'AED' })
const criteria = { agencyId: 'agency', market: 'AE', nationality: 'IN', currency: 'AED' as const, children: 0 }
const gates = (reasons: string[] = [], overrides = {}) => buildHotelStayReadiness('hotel', [plan(reasons)], '2030-01-01T00:00:00Z', { ...criteria, ...overrides }).plans[0].gates

describe('Hotel stay diagnostic boundaries', () => {
  it('never turns an eligible evaluator decision into search/recheck certification', () => {
    const result = buildHotelStayReadiness('hotel', [plan()], '2030-01-01T00:00:00Z', criteria)
    expect(result.certification).toBe('NOT_VERIFIED')
    expect(result.plans[0].gates.find(g => g.key === 'search_recheck')).toMatchObject({ state: 'UNKNOWN', action: null })
    expect(result.plans[0].gates.slice(0, 6).every(g => g.state === 'PASS')).toBe(true)
  })
  it.each(['INVENTORY_STALE', 'AVAILABILITY_MISSING', 'POOL_EXHAUSTED', 'ON_REQUEST_ONLY', 'CLOSED_TO_DEPARTURE', 'RELEASE_DAYS_NOT_MET'])('retains %s as an inventory blocker', reason => {
    expect(gates([reason]).find(g => g.key === 'inventory')).toMatchObject({ state: 'FAIL', reasons: [reason] })
  })
  it.each(['AGENCY_SUSPENDED', 'DISTRIBUTION_RESTRICTED', 'SOURCE_MARKET_NOT_ALLOWED', 'NATIONALITY_NOT_ALLOWED', 'CONTRACT_MARKET_RULE_INVALID'])('retains %s as a buyer blocker', reason => {
    expect(gates([reason]).find(g => g.key === 'distribution')).toMatchObject({ state: 'FAIL', reasons: [reason] })
  })
  it('does not certify absent buyer/currency context or child policies', () => {
    expect(gates([], { agencyId: null }).find(g => g.key === 'distribution')?.state).toBe('UNKNOWN')
    expect(gates([], { currency: null }).find(g => g.key === 'rate')?.state).toBe('UNKNOWN')
    expect(gates([], { children: 1 }).find(g => g.key === 'inventory')?.state).toBe('UNKNOWN')
  })
  it('keeps failures and references per plan; a passing plan cannot mask another failure', () => {
    const result = buildHotelStayReadiness('hotel', [plan(), plan(['DAILY_RATE_MISSING_OR_INVALID'], 'other')], '2030-01-01T00:00:00Z', criteria)
    expect(result.plans[0].gates.find(g => g.key === 'rate')?.state).toBe('PASS')
    expect(result.plans[1].gates.find(g => g.key === 'rate')).toMatchObject({ state: 'FAIL', entityRefs: { hotelId: 'hotel', roomTypeId: 'room', ratePlanId: 'other' }, criteriaRef: 'request', evaluatedAt: '2030-01-01T00:00:00Z' })
  })
  it('never loses unfamiliar blocking reasons or invents passing gates for absent plans', () => {
    expect(gates(['FUTURE_RULE']).find(g => g.key === 'contract')).toMatchObject({ state: 'FAIL', reasons: ['FUTURE_RULE'] })
    expect(buildHotelStayReadiness('hotel', [], '2030-01-01T00:00:00Z', criteria).plans).toEqual([])
  })
})
