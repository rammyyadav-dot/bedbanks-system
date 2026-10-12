import { canonicalPlanContent, planFingerprint, type FingerprintPlan, type FingerprintRate } from './rate-plan-fingerprint'

const plan: FingerprintPlan = {
  contractId: 'c', roomTypeId: 'r', boardBasisId: 'b', code: 'P1', occupancy: 2, currency: 'AED', refundable: true, taxesIncluded: false, feesIncluded: false,
  minStay: 1, maxStay: null, releaseDays: 0, releaseTimeLocal: '00:00', inventoryPoolId: null, validFrom: null, validTo: null, paymentType: 'PREPAID',
  cancellationPolicySet: null, salesMarkets: ['AE', 'IN'], nationalities: [],
}
const rate = (d: string, amountMinor: bigint, occupancy = 2): FingerprintRate => ({ stayDate: new Date(`${d}T00:00:00Z`), occupancy, amountMinor, amountBasis: 'SELL', currency: 'AED' })
const rates = [rate('2026-11-01', 45000n), rate('2026-11-02', 46000n)]
const fp = (p = plan, r = rates, asOf = '2026-10-12') => planFingerprint(p, r, asOf)

describe('rate plan fingerprint (ADR 0057, S5)', () => {
  it('is stable: row order, list order and an unrelated past row do not change it', () => {
    expect(fp()).toBe(fp(plan, [...rates].reverse()))
    expect(fp()).toBe(fp({ ...plan, salesMarkets: ['IN', 'AE'] }))
    expect(fp()).toBe(fp(plan, [rate('2026-10-01', 1n), ...rates])) // before asOf
  })
  it('changes when any price, term or night changes', () => {
    const base = fp()
    expect(fp(plan, [rate('2026-11-01', 45001n), rates[1]])).not.toBe(base)
    expect(fp(plan, [...rates, rate('2026-11-03', 47000n)])).not.toBe(base)
    expect(fp(plan, rates.slice(0, 1))).not.toBe(base)
    for (const change of [{ code: 'P2' }, { refundable: false }, { minStay: 2 }, { validTo: new Date('2026-12-31T00:00:00Z') }, { paymentType: 'PAY_AT_HOTEL' }, { cancellationPolicySet: 'FLEX' }, { salesMarkets: ['AE'] }, { nationalities: ['IN'] }, { currency: 'USD' }, { inventoryPoolId: 'pool' }]) {
      expect(fp({ ...plan, ...change })).not.toBe(base)
    }
  })
  it('distinguishes a basis change and an occupancy change', () => {
    expect(fp(plan, [{ ...rates[0], amountBasis: 'NET' }, rates[1]])).not.toBe(fp())
    expect(fp(plan, [rate('2026-11-01', 45000n, 3), rates[1]])).not.toBe(fp())
  })
  it('keeps bigint amounts exact and contains no free text or person data', () => {
    const json = canonicalPlanContent(plan, [rate('2026-11-01', 9007199254740993n)], '2026-10-12')
    expect(json).toContain('"9007199254740993"')
    expect(json).not.toMatch(/user|email|reason/i)
  })
  it('covers the child and extra-adult lines: any change to a line changes it (ADR 0057, S6)', () => {
    const line = { kind: 'CHILD', minAge: 3, maxAge: 11, amountMinor: 15_000n, amountBasis: 'SELL', currency: 'AED' }
    const base = planFingerprint(plan, rates, '2026-10-12', [line])
    expect(base).not.toBe(planFingerprint(plan, rates, '2026-10-12', []))
    for (const change of [{ amountMinor: 15_001n }, { minAge: 4 }, { maxAge: 10 }, { amountBasis: 'NET' }, { kind: 'EXTRA_ADULT' }, { currency: 'USD' }]) {
      expect(planFingerprint(plan, rates, '2026-10-12', [{ ...line, ...change }])).not.toBe(base)
    }
    expect(planFingerprint(plan, rates, '2026-10-12', [line, { ...line, minAge: 0, maxAge: 2 }])).toBe(planFingerprint(plan, rates, '2026-10-12', [{ ...line, minAge: 0, maxAge: 2 }, line])) // order is irrelevant
  })
})
