import {
  EMPTY_HEADER, normaliseHeader, activationAllowedFrom, amendmentProblems, applyAmendment, assessContractActivation, lifecycleTarget, nextVersion, normaliseAmendment, termsEditable, termsFingerprint,
  type ContractTerms, type PlanFacts,
} from './contract-lifecycle'

const terms = (over: Partial<ContractTerms> = {}): ContractTerms => ({
  code: 'DXB-2027', supplierId: 's1', supplierHotelMappingId: 'm1', validFrom: '2026-11-01', validTo: '2027-10-31', settlementCurrency: 'AED',
  salesMarkets: [], nationalities: [], paymentPolicyRef: null,
  cancellationPolicies: [{ policySet: null, kind: 'CANCELLATION' as const, daysBeforeCheckin: 3, penaltyPercent: 100, penaltyMinor: null, penaltyNights: null, currency: null }],
  childPolicies: [{ minAge: 0, maxAge: 5, extraBedAllowed: false, supplementMinor: '0', currency: 'AED' }],
  leadTimeRule: null, header: EMPTY_HEADER, ...over,
})
const plan = (over: Partial<PlanFacts> = {}): PlanFacts => ({ code: 'P1', status: 'DRAFT', currency: 'AED', refundable: true, cancellationPolicySet: null, validFrom: null, validTo: null, ...over })
const facts = (over: Partial<Parameters<typeof assessContractActivation>[0]> = {}) => ({ today: '2026-10-17', status: 'REVIEW', terms: terms(), supplierStatus: 'ACTIVE', mappingStatus: 'MAPPED', plans: [plan()], ...over })
const failed = (r: ReturnType<typeof assessContractActivation>) => r.checks.filter((c) => !c.ok).map((c) => c.code)

describe('contract lifecycle (ADR 0067, F-01)', () => {
  it('locks terms while ACTIVE or EXPIRED and allows direct edits in DRAFT, REVIEW and SUSPENDED', () => {
    expect(['DRAFT', 'REVIEW', 'SUSPENDED'].map(termsEditable)).toEqual([true, true, true])
    expect(['ACTIVE', 'EXPIRED'].map(termsEditable)).toEqual([false, false])
  })

  it('never offers activation as a single-actor transition', () => {
    expect(lifecycleTarget('submit', 'DRAFT')).toBe('REVIEW')
    expect(lifecycleTarget('return', 'REVIEW')).toBe('DRAFT')
    expect(lifecycleTarget('suspend', 'ACTIVE')).toBe('SUSPENDED')
    for (const from of ['DRAFT', 'REVIEW', 'SUSPENDED', 'EXPIRED']) for (const a of ['submit', 'return', 'suspend'] as const) expect(lifecycleTarget(a, from)).not.toBe('ACTIVE')
    expect(lifecycleTarget('submit', 'ACTIVE')).toBeNull()
    expect([activationAllowedFrom('EXPIRED'), activationAllowedFrom('ACTIVE'), activationAllowedFrom('SUSPENDED')]).toEqual([false, false, true])
  })

  it('fingerprints the terms independent of row order, and changes on any policy edit', () => {
    const a = terms({ cancellationPolicies: [{ policySet: null, kind: 'CANCELLATION' as const, daysBeforeCheckin: 3, penaltyPercent: 100, penaltyMinor: null, penaltyNights: null, currency: null }, { policySet: null, kind: 'CANCELLATION' as const, daysBeforeCheckin: 7, penaltyPercent: 50, penaltyMinor: null, penaltyNights: null, currency: null }] })
    const b = terms({ cancellationPolicies: [...a.cancellationPolicies].reverse() })
    expect(termsFingerprint(a)).toBe(termsFingerprint(b))
    expect(termsFingerprint(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(termsFingerprint(terms({ childPolicies: [] }))).not.toBe(termsFingerprint(terms()))
    expect(termsFingerprint(terms({ leadTimeRule: { minLeadHours: 24, maxLeadDays: null } }))).not.toBe(termsFingerprint(terms()))
  })

  it('activation passes a sound contract and names every failing check', () => {
    expect(assessContractActivation(facts()).ready).toBe(true)
    expect(failed(assessContractActivation(facts({ status: 'ACTIVE' })))).toEqual(['STATUS_ALLOWED'])
    expect(failed(assessContractActivation(facts({ terms: terms({ validTo: '2026-10-16' }) })))).toEqual(['VALIDITY'])
    expect(failed(assessContractActivation(facts({ supplierStatus: 'SUSPENDED' })))).toEqual(['SUPPLIER_ACTIVE'])
    expect(failed(assessContractActivation(facts({ mappingStatus: 'PENDING' })))).toEqual(['MAPPING_APPROVED'])
    expect(assessContractActivation(facts({ mappingStatus: null })).ready).toBe(true)
    expect(failed(assessContractActivation(facts({ plans: [plan({ currency: 'USD' })] })))).toEqual(['PLANS_CONSISTENT'])
  })

  it('validates amendments and refuses identity, status and unknown keys', () => {
    expect(normaliseAmendment({ validTo: '2027-12-31', salesMarkets: ['ae', 'SA'] }).changes).toEqual({ validTo: '2027-12-31', salesMarkets: ['AE', 'SA'] })
    expect(normaliseAmendment({ supplierId: 'x' }).errors[0]).toMatch(/identify a contract/)
    expect(normaliseAmendment({ status: 'ACTIVE' }).errors[0]).toMatch(/never changes status/)
    expect(normaliseAmendment({ foo: 1 }).errors[0]).toMatch(/not an amendable term/)
    // A stored amendment round-trips: its nested header parses to the same changes (ADR 0067, F-20).
    const filed = normaliseAmendment({ rateType: 'COMMISSIONABLE', commissionBp: 1000, minStayMode: 'ARRIVAL' }).changes!
    expect(normaliseAmendment(JSON.parse(JSON.stringify(filed))).changes).toEqual(filed)
    expect(normaliseAmendment({}).errors[0]).toMatch(/at least one/)
    expect(normaliseAmendment({ validTo: '2027-02-30' }).errors).toHaveLength(1)
    expect(normaliseAmendment({ cancellationPolicies: [{ daysBeforeCheckin: 3, penaltyPercent: 50, penaltyMinor: '100' }] }).errors[0]).toMatch(/exactly one/)
    // ADR 0067 F-10: nights penalties, no-show rules on arrival, and the client buffer as a header term.
    expect(normaliseAmendment({ cancellationPolicies: [{ daysBeforeCheckin: 3, penaltyNights: 1 }, { kind: 'NO_SHOW', daysBeforeCheckin: 0, penaltyPercent: 100 }] }).changes!.cancellationPolicies!.map((p) => [p.kind, p.penaltyNights])).toEqual([['CANCELLATION', 1], ['NO_SHOW', null]])
    expect(normaliseAmendment({ cancellationPolicies: [{ kind: 'NO_SHOW', daysBeforeCheckin: 2, penaltyPercent: 100 }] }).errors.join(' ')).toMatch(/applies on arrival/)
    expect(normaliseAmendment({ cancellationPolicies: [{ daysBeforeCheckin: 3, penaltyNights: 31 }] }).errors.join(' ')).toMatch(/1 to 30/)
    expect(normaliseAmendment({ clientBufferDays: 2 }).changes).toEqual({ header: { clientBufferDays: 2 } })
    expect(normaliseAmendment({ clientBufferDays: 31 }).errors.join(' ')).toMatch(/clientBufferDays/)
    expect(normaliseAmendment({ childPolicies: [{ minAge: 0, maxAge: 5 }, { minAge: 5, maxAge: 11 }] }).errors[0]).toMatch(/overlap/)
    expect(normaliseAmendment({ leadTimeRule: { minLeadHours: 48, maxLeadDays: 365 } }).changes).toEqual({ leadTimeRule: { minLeadHours: 48, maxLeadDays: 365 } })
  })

  it('refuses an amendment that breaks a plan under the contract, or changes nothing', () => {
    const before = terms()
    expect(amendmentProblems(before, before, [])).toEqual(['The amendment changes nothing.'])
    expect(amendmentProblems(before, applyAmendment(before, { settlementCurrency: 'USD' }), [plan()])).toEqual([expect.stringMatching(/child band is in AED/), expect.stringMatching(/another currency than USD/)])
    expect(amendmentProblems(before, applyAmendment(before, { validTo: '2027-03-31' }), [plan({ validTo: '2027-06-30' })])[0]).toMatch(/outside 2026-11-01 to 2027-03-31/)
    const noShow = { policySet: null, kind: 'NO_SHOW' as const, daysBeforeCheckin: 0, penaltyPercent: 100, penaltyMinor: null, penaltyNights: null, currency: null }
    expect(amendmentProblems(before, applyAmendment(before, { cancellationPolicies: [...before.cancellationPolicies, noShow, noShow] }), [])).toContain('Cancellation set default has more than one no-show rule.')
    expect(amendmentProblems(before, applyAmendment(before, { cancellationPolicies: [] }), [plan({ cancellationPolicySet: 'FLEX' })])).toEqual(expect.arrayContaining([expect.stringMatching(/cancellation set/)]))
    expect(amendmentProblems(before, applyAmendment(before, { validTo: '2027-12-31' }), [plan({ status: 'EXPIRED', currency: 'USD' })])).toEqual([])
  })

  it('raises the version on every amendment, and on reactivation only when the terms changed since the last snapshot', () => {
    expect(nextVersion(1, null, 'a', 'ACTIVATION')).toBe(1)
    expect(nextVersion(1, { version: 1, fingerprint: 'a' }, 'a', 'ACTIVATION')).toBe(1)
    expect(nextVersion(1, { version: 1, fingerprint: 'a' }, 'b', 'ACTIVATION')).toBe(2)
    expect(nextVersion(2, { version: 2, fingerprint: 'b' }, 'c', 'AMENDMENT')).toBe(3)
  })

  it('validates the commercial header and its combination (ADR 0067, F-20/F-15)', () => {
    const errors: string[] = []
    expect(normaliseHeader({ rateType: 'COMMISSIONABLE', commissionBp: 1000, paymentTermsDays: 30, signedAt: '2026-10-01', allotmentType: 'GUARANTEED', minStayMode: 'ARRIVAL' }, EMPTY_HEADER, errors))
      .toEqual({ rateType: 'COMMISSIONABLE', commissionBp: 1000, paymentTermsDays: 30, signedAt: '2026-10-01', signedDocumentRef: null, allotmentType: 'GUARANTEED', minStayMode: 'ARRIVAL', clientBufferDays: 0 })
    expect(errors).toEqual([])
    const bad: string[] = []
    normaliseHeader({ rateType: 'COMMISSIONABLE', paymentTermsDays: 400, minStayMode: 'NIGHTLY', signedAt: '2026-02-30' }, EMPTY_HEADER, bad)
    expect(new Set(bad.map((e) => e.split(':')[0]))).toEqual(new Set(['signedAt', 'paymentTermsDays', 'minStayMode', 'commissionBp']))
    const net: string[] = []
    normaliseHeader({ rateType: 'NET', commissionBp: 500 }, EMPTY_HEADER, net)
    expect(net).toEqual([expect.stringMatching(/only a commissionable contract/)])
  })

  it('amends header terms, raises the fingerprint, and refuses an inconsistent combination', () => {
    const before = terms()
    expect(normaliseAmendment({ minStayMode: 'ARRIVAL', paymentTermsDays: 14 }).changes).toEqual({ header: { minStayMode: 'ARRIVAL', paymentTermsDays: 14 } })
    const after = applyAmendment(before, { header: { minStayMode: 'ARRIVAL' } })
    expect(after.header.minStayMode).toBe('ARRIVAL')
    expect(termsFingerprint(after)).not.toBe(termsFingerprint(before))
    expect(amendmentProblems(before, applyAmendment(before, { header: { rateType: 'COMMISSIONABLE' } }), [])).toEqual([expect.stringMatching(/needs its commission/)])
  })
})
