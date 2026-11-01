import { assessRatePlanActivation, cloneDraftFields, rateGaps, transitionTarget, type ActivationFacts } from './rate-plan-activation'

const rate = (stayDate: string, over: Partial<ActivationFacts['rates'][number]> = {}) => ({ stayDate, amountBasis: 'NET', currency: 'AED', amountMinor: 45000n, ...over })
const base = (over: Partial<ActivationFacts> = {}): ActivationFacts => ({
  today: '2026-10-11',
  plan: { status: 'DRAFT', currency: 'AED', occupancy: 2, refundable: true, minStay: 1, maxStay: null, inventoryPoolId: null, validFrom: null, validTo: null, cancellationPolicySet: null, markets: { salesMarkets: [], nationalities: [] } },
  room: { hotelId: 'h1', maxOccupancy: 3, isActive: true },
  board: { isActive: true },
  contract: { status: 'ACTIVE', validFrom: '2026-01-01', validTo: '2027-12-31', settlementCurrency: 'AED', mappedHotelId: 'h1', cancellationPolicyCount: 1, markets: { salesMarkets: [], nationalities: [] } },
  rates: [rate('2026-10-11'), rate('2026-10-12'), rate('2026-10-13')],
  availabilityDates: ['2026-10-11'],
  guestPrices: [], promotions: [], derived: { derived: false, problem: null },
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
    const source = { contractId: 'c', roomTypeId: 'r1', boardBasisId: 'b', occupancy: 2, currency: 'AED', refundable: false, taxesIncluded: true, feesIncluded: false, minStay: 2, maxStay: 7, releaseDays: 3, releaseTimeLocal: '12:00', validFrom: new Date('2026-11-01T00:00:00Z'), validTo: null, paymentType: 'PREPAID' as const, cancellationPolicySet: 'FLEX', salesMarkets: ['AE'], nationalities: [], status: 'ACTIVE', id: 'x', inventoryPoolId: 'pool' }
    const copy = cloneDraftFields(source, { code: 'NEW', roomTypeId: 'r2' })
    expect(copy).toMatchObject({ code: 'NEW', roomTypeId: 'r2', status: 'DRAFT', refundable: false, minStay: 2, maxStay: 7, releaseTimeLocal: '12:00', paymentType: 'PREPAID' })
    expect(copy.validFrom?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(copy).not.toHaveProperty('id')
    expect(copy).not.toHaveProperty('inventoryPoolId')
  })
})

describe('rate plan sale window (ADR 0057)', () => {
  const withWindow = (validFrom: string | null, validTo: string | null) => base({ plan: { ...base().plan, validFrom, validTo } })
  it('passes when the plan inherits the contract term', () => { expect(failed(withWindow(null, null))).toEqual([]) })
  it('passes for a window inside the contract term', () => { expect(failed(withWindow('2026-10-01', '2026-12-31'))).toEqual([]) })
  it('fails a window that starts before the contract', () => { expect(failed(withWindow('2025-12-01', null))).toEqual(['PLAN_VALIDITY']) })
  it('fails a window that ends after the contract', () => { expect(failed(withWindow(null, '2028-01-01'))).toEqual(['PLAN_VALIDITY']) })
  it('fails an inverted window', () => { expect(failed(withWindow('2026-12-01', '2026-11-01'))).toEqual(['PLAN_VALIDITY']) })
  it('fails a window that is already over', () => { expect(failed(withWindow('2026-01-01', '2026-10-10'))).toEqual(['PLAN_VALIDITY']) })
})

describe('rate plan cancellation set (ADR 0057)', () => {
  const refundable = (cancellationPolicySet: string | null, count: number) => base({ plan: { ...base().plan, cancellationPolicySet }, contract: { ...base().contract, cancellationPolicyCount: count } })
  it('passes with rules in the named set', () => { expect(failed(refundable('FLEX', 2))).toEqual([]) })
  it('fails when the named set has no rules and says which set', () => {
    expect(failed(refundable('FLEX', 0))).toEqual(['CANCELLATION_POLICY'])
    expect(assessRatePlanActivation(refundable('FLEX', 0)).checks.find((c) => c.code === 'CANCELLATION_POLICY')?.message).toContain('"FLEX"')
  })
  it('still fails a refundable plan on the contract default with no rules', () => { expect(failed(refundable(null, 0))).toEqual(['CANCELLATION_POLICY']) })
})

describe('rate plan buyer markets (ADR 0057, S3)', () => {
  const lists = (plan: [string[] | null, string[] | null], contract: [string[] | null, string[] | null]) => base({
    plan: { ...base().plan, markets: { salesMarkets: plan[0], nationalities: plan[1] } },
    contract: { ...base().contract, markets: { salesMarkets: contract[0], nationalities: contract[1] } },
  })
  it('passes with no plan restriction, and with a plan list inside the contract list', () => {
    expect(failed(lists([[], []], [['AE'], []]))).toEqual([])
    expect(failed(lists([['AE'], ['IN']], [['AE', 'SA'], []]))).toEqual([])
  })
  it('fails a plan list the restricted contract does not allow, naming the code', () => {
    const facts = lists([['US'], []], [['AE'], []])
    expect(failed(facts)).toEqual(['PLAN_MARKETS'])
    expect(assessRatePlanActivation(facts).checks.find((c) => c.code === 'PLAN_MARKETS')?.message).toContain('US')
  })
  it('allows any plan list under an unrestricted contract', () => { expect(failed(lists([['US'], ['IN']], [[], []]))).toEqual([]) })
  it('fails a malformed plan list', () => { expect(failed(lists([null, []], [[], []]))).toEqual(['PLAN_MARKETS']) })
})

describe('rate plan guest prices (ADR 0057, S6)', () => {
  const line = (over: Partial<ActivationFacts['guestPrices'][number]> = {}): ActivationFacts['guestPrices'][number] => ({ kind: 'CHILD', minAge: 3, maxAge: 11, amountMinor: 15_000n, basis: 'NET', currency: 'AED', ...over })
  const withLines = (guestPrices: ActivationFacts['guestPrices']) => base({ guestPrices })
  it('passes with no lines (the plan sells its flat occupancy) and with a coherent set on the rates\' basis', () => {
    expect(failed(withLines([]))).toEqual([])
    expect(failed(withLines([line(), line({ minAge: 0, maxAge: 2, amountMinor: 0n }), { ...line({ kind: 'EXTRA_ADULT', minAge: 18, maxAge: 99 }) }]))).toEqual([])
  })
  it('fails overlapping bands, a wrong currency, and a duplicate extra-adult line, and says which', () => {
    expect(failed(withLines([line(), line({ minAge: 8, maxAge: 14 })]))).toEqual(['GUEST_PRICES_VALID'])
    expect(assessRatePlanActivation(withLines([line({ currency: 'USD' })])).checks.find((c) => c.code === 'GUEST_PRICES_VALID')?.message).toMatch(/currency/)
    expect(failed(withLines([line({ kind: 'EXTRA_ADULT', minAge: 18, maxAge: 99 }), line({ kind: 'EXTRA_ADULT', minAge: 18, maxAge: 99 })]))).toEqual(['GUEST_PRICES_VALID'])
  })
  it('fails a line whose basis differs from the rates it is added to', () => {
    expect(failed(withLines([line({ basis: 'SELL' })]))).toEqual(['GUEST_PRICES_VALID']) // the fixture rates are NET
  })
})


describe('rate plan promotions (ADR 0058, S10a)', () => {
  const promo = (over: Record<string, unknown> = {}): ActivationFacts['promotions'][number] => ({ id: 'p1', kind: 'EARLY_BIRD', name: 'Book early', percentBp: 1000, minLeadDays: 7, maxLeadDays: null, minNights: null, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null, ...over } as ActivationFacts['promotions'][number])
  it('passes with none and with a valid set', () => {
    expect(failed(base({ promotions: [] }))).toEqual([])
    expect(failed(base({ promotions: [promo(), promo({ id: 'p2', name: 'Late', kind: 'LAST_MINUTE', percentBp: 500, minLeadDays: null, maxLeadDays: 3 })] }))).toEqual([])
  })
  it('fails a promotion the validator would refuse, so a hand-edited row cannot sell a surprise discount', () => {
    expect(failed(base({ promotions: [promo({ percentBp: 9500 })] }))).toEqual(['PROMOTIONS_VALID'])
    expect(failed(base({ promotions: [promo(), promo({ id: 'p2' })] }))).toEqual(['PROMOTIONS_VALID'])
  })
})
