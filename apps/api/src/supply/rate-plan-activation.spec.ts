import { assessRatePlanActivation, cloneDraftFields, rateGaps, transitionTarget, type ActivationFacts } from './rate-plan-activation'

const rate = (stayDate: string, over: Partial<ActivationFacts['rates'][number]> = {}) => ({ stayDate, amountBasis: 'NET', currency: 'AED', amountMinor: 45000n, ...over })
const base = (over: Partial<ActivationFacts> = {}): ActivationFacts => ({
  today: '2026-10-11',
  plan: { status: 'DRAFT', currency: 'AED', occupancy: 2, refundable: true, minStay: 1, maxStay: null, inventoryPoolId: null },
  room: { hotelId: 'h1', maxOccupancy: 3, isActive: true },
  board: { isActive: true },
  contract: { status: 'ACTIVE', validFrom: '2026-01-01', validTo: '2027-12-31', settlementCurrency: 'AED', mappedHotelId: 'h1', cancellationPolicyCount: 1 },
  rates: [rate('2026-10-11'), rate('2026-10-12'), rate('2026-10-13')],
  availabilityDates: ['2026-10-11'],
  ...over,
})
const failed = (facts: ActivationFacts) => assessRatePlanActivation(facts).checks.filter((c) => !c.ok).map((c) => c.code)

describe('rate plan activation readiness', () => {
  it('is ready when every fact is satisfied', () => {
    const result = assessRatePlanActivation(base())
    expect(result.ready).toBe(true)
    expect(failed(base())).toEqual([])
  })

  it('fails closed when there are no rates at all', () => {
    expect(failed(base({ rates: [] }))).toContain('RATES_PRESENT')
  })

  it('ignores past rates when judging coverage', () => {
    expect(failed(base({ rates: [rate('2026-09-01')] }))).toContain('RATES_PRESENT')
  })

  it('reports missing nights instead of filling them', () => {
    expect(rateGaps(['2026-10-11', '2026-10-14'])).toEqual(['2026-10-12', '2026-10-13'])
    expect(failed(base({ rates: [rate('2026-10-11'), rate('2026-10-14')] }))).toEqual(['RATES_CONTIGUOUS'])
  })

  it('handles month boundaries when finding gaps', () => {
    expect(rateGaps(['2026-10-30', '2026-11-02'])).toEqual(['2026-10-31', '2026-11-01'])
  })

  it('rejects unclassified, foreign-currency and non-positive rates', () => {
    expect(failed(base({ rates: [rate('2026-10-11', { amountBasis: null })] }))).toEqual(['RATES_CLASSIFIED'])
    expect(failed(base({ rates: [rate('2026-10-11', { currency: 'USD' })] }))).toEqual(['RATES_CURRENCY'])
    expect(failed(base({ rates: [rate('2026-10-11', { amountMinor: 0n })] }))).toEqual(['RATES_POSITIVE'])
  })

  it('requires an active, in-date contract mapped to the room hotel', () => {
    const contract = base().contract
    expect(failed(base({ contract: { ...contract, status: 'DRAFT' } }))).toEqual(['CONTRACT_ACTIVE'])
    expect(failed(base({ contract: { ...contract, validTo: '2026-10-10' } }))).toEqual(['CONTRACT_VALID'])
    expect(failed(base({ contract: { ...contract, mappedHotelId: null } }))).toEqual(['CONTRACT_MAPPED'])
    expect(failed(base({ contract: { ...contract, mappedHotelId: 'other' } }))).toEqual(['CONTRACT_MAPPED'])
  })

  it('does not allow a currency that differs from the contract', () => {
    const facts = base()
    expect(failed({ ...facts, plan: { ...facts.plan, currency: 'USD' }, rates: [rate('2026-10-11', { currency: 'USD' })] })).toEqual(['CURRENCY_MATCH'])
  })

  it('bounds occupancy by room capacity', () => {
    const facts = base()
    expect(failed({ ...facts, plan: { ...facts.plan, occupancy: 4 } })).toEqual(['OCCUPANCY_VALID'])
    expect(failed({ ...facts, plan: { ...facts.plan, occupancy: 0 } })).toEqual(['OCCUPANCY_VALID'])
  })

  it('never substitutes a cancellation policy for a refundable plan', () => {
    const facts = base()
    expect(failed({ ...facts, contract: { ...facts.contract, cancellationPolicyCount: 0 } })).toEqual(['CANCELLATION_POLICY'])
    expect(failed({ ...facts, plan: { ...facts.plan, refundable: false }, contract: { ...facts.contract, cancellationPolicyCount: 0 } })).toEqual([])
  })

  it('treats unknown inventory as not ready unless a pool backs the plan', () => {
    const facts = base()
    expect(failed({ ...facts, availabilityDates: [] })).toEqual(['INVENTORY_LINKED'])
    expect(failed({ ...facts, availabilityDates: ['2026-09-01'] })).toEqual(['INVENTORY_LINKED'])
    expect(failed({ ...facts, availabilityDates: [], plan: { ...facts.plan, inventoryPoolId: 'pool' } })).toEqual([])
  })

  it('flags inconsistent stay rules and inactive references', () => {
    const facts = base()
    expect(failed({ ...facts, plan: { ...facts.plan, minStay: 3, maxStay: 2 } })).toEqual(['STAY_RULES_VALID'])
    expect(failed({ ...facts, room: { ...facts.room, isActive: false } })).toEqual(['ROOM_ACTIVE'])
    expect(failed({ ...facts, board: { isActive: false } })).toEqual(['BOARD_ACTIVE'])
  })

  it('blocks activation of active and expired plans', () => {
    const facts = base()
    expect(failed({ ...facts, plan: { ...facts.plan, status: 'EXPIRED' } })).toEqual(['STATUS_ALLOWED'])
    expect(failed({ ...facts, plan: { ...facts.plan, status: 'ACTIVE' } })).toEqual(['STATUS_ALLOWED'])
  })
})

describe('rate plan transitions', () => {
  it('only moves along the permitted lifecycle', () => {
    expect(transitionTarget('activate', 'DRAFT')).toBe('ACTIVE')
    expect(transitionTarget('activate', 'SUSPENDED')).toBe('ACTIVE')
    expect(transitionTarget('activate', 'EXPIRED')).toBeNull()
    expect(transitionTarget('activate', 'ACTIVE')).toBeNull()
    expect(transitionTarget('suspend', 'ACTIVE')).toBe('SUSPENDED')
    expect(transitionTarget('suspend', 'DRAFT')).toBeNull()
    expect(transitionTarget('suspend', 'EXPIRED')).toBeNull()
  })
})

describe('rate plan clone', () => {
  it('copies commercial shape into a draft with the new code and nothing else', () => {
    const source = { contractId: 'c', roomTypeId: 'r1', boardBasisId: 'b', occupancy: 2, currency: 'AED', refundable: false, taxesIncluded: true, feesIncluded: false, minStay: 2, maxStay: 7, releaseDays: 3, releaseTimeLocal: '12:00', status: 'ACTIVE', id: 'x', inventoryPoolId: 'pool' }
    const copy = cloneDraftFields(source, { code: 'NEW', roomTypeId: 'r2' })
    expect(copy).toMatchObject({ code: 'NEW', roomTypeId: 'r2', status: 'DRAFT', refundable: false, minStay: 2, maxStay: 7, releaseTimeLocal: '12:00' })
    expect(copy).not.toHaveProperty('id')
    expect(copy).not.toHaveProperty('inventoryPoolId')
  })
})
