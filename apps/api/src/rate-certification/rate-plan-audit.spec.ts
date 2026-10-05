import { windowDates } from '../supply/commercial-assessment'
import type { MarkupRuleRow } from '../supply/markup-rules'
import { auditHotel, auditMarkupRules, classifyRateRow, markupRemediation, remediationItems, simulateStay, suggestRatePlanCode, type AuditHotelInput, type AuditPlan } from './rate-plan-audit'

const TODAY = '2030-06-01'
const dates = windowDates(TODAY, 5)
const at = (day: string) => new Date(`${day}T00:00:00.000Z`)
const NET_RULE: MarkupRuleRow = { scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints: 1000, validFrom: '2030-01-01', validTo: null }

interface PlanOpts {
  id?: string; code?: string; status?: string; occupancy?: number; currency?: string; contractId?: string; contractStatus?: string; contractCurrency?: string
  validFrom?: string; validTo?: string; basis?: 'SELL' | 'NET' | null; amount?: bigint; rateCurrency?: string; rateOccupancy?: number; rateDates?: string[]
  salesMarkets?: unknown; nationalities?: unknown; maxOccupancy?: number; boardId?: string; refundable?: boolean
}
function plan(o: PlanOpts = {}): AuditPlan {
  const id = o.id ?? 'plan-1'
  return {
    id, code: o.code ?? `RP-${id.toUpperCase()}`, status: o.status ?? 'ACTIVE', occupancy: o.occupancy ?? 2, currency: o.currency ?? 'AED', minStay: 1, maxStay: null, releaseDays: 0, refundable: o.refundable ?? true,
    contractId: o.contractId ?? 'c1', roomTypeId: 'room-1', boardBasisId: o.boardId ?? 'b1',
    boardBasis: { code: 'BB', isActive: true },
    roomType: { id: 'room-1', name: 'Deluxe', code: 'DLX', hotelId: 'h1', isActive: true, maxAdults: 2, maxChildren: 0, maxOccupancy: o.maxOccupancy ?? 2, hotel: { contentStatus: 'COMPLETE', timeZone: 'Asia/Dubai' } },
    contract: { id: o.contractId ?? 'c1', code: `C-${o.contractId ?? 'c1'}`, status: o.contractStatus ?? 'ACTIVE', validFrom: at(o.validFrom ?? '2030-01-01'), validTo: at(o.validTo ?? '2031-01-01'), settlementCurrency: o.contractCurrency ?? 'AED', supplierId: 's1', supplierHotelMappingId: 'm1', supplier: { status: 'ACTIVE', displayName: 'Supplier One' }, salesMarkets: o.salesMarkets ?? [], nationalities: o.nationalities ?? [] },
    dailyRates: (o.rateDates ?? dates).map((d) => ({ stayDate: at(d), amountMinor: o.amount ?? 30_000n, currency: o.rateCurrency ?? 'AED', amountBasis: o.basis === undefined ? 'SELL' as const : o.basis, occupancy: o.rateOccupancy ?? o.occupancy ?? 2 })),
    availability: dates.map((d) => ({ stayDate: at(d), allotment: 5, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false })),
  }
}
function input(plans: AuditPlan[], over: Partial<AuditHotelInput> = {}): AuditHotelInput {
  return {
    hotel: { id: 'h1', name: 'Test Hotel', contentStatus: 'COMPLETE', starRating: 5 }, city: 'Dubai', enabledCurrencies: ['AED'],
    rooms: [{ id: 'room-1', name: 'Deluxe', code: 'DLX', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true }],
    plans, contracts: [],
    mappings: [{ id: 'm1', supplierId: 's1', supplierName: 'Supplier One', hotelId: 'h1', status: 'MAPPED', supplierHotelId: 'SUP-H1', confidence: null, updatedAt: at(TODAY) }],
    roomMappings: [{ id: 'rm1', supplierHotelMappingId: 'm1', roomTypeId: 'room-1', supplierRoomId: 'SUP-R1', status: 'MAPPED', confidence: null, updatedAt: at(TODAY) }],
    dates, today: TODAY, observedAt: '2030-06-01T00:00:00.000Z', markupRules: [], ...over,
  }
}
const codes = (plans: ReturnType<typeof auditHotel>['plans']) => plans[0].findings.map((f) => f.code)

describe('rate plan audit (RC)', () => {
  it('RC-01: a clean SELL plan passes and the hotel is CERTIFIED', () => {
    const a = auditHotel(input([plan()]))
    expect(a.plans[0]).toMatchObject({ status: 'PASS', live: true, findings: [], sellableNights: 5, amountBasis: 'SELL' })
    expect(a.plans[0].rowClasses).toEqual({ VALID: 5, QUARANTINED: 0, DEAD: 0, OUTSIDE_CONTRACT: 0, BLOCKED_NO_MARKUP: 0 })
    expect(a.certification).toMatchObject({ status: 'CERTIFIED', blockers: [], warnings: [], plans: { total: 1, live: 1, pass: 1, warn: 0, fail: 0 } })
  })

  it('RC-02: a zero amount is quarantined and fails the plan, even though the evaluator would still price it', () => {
    const a = auditHotel(input([plan({ amount: 0n })]))
    expect(a.plans[0].rowClasses.QUARANTINED).toBe(5)
    expect(a.plans[0].status).toBe('FAIL')
    expect(codes(a.plans)).toContain('RATE_AMOUNT_ZERO')
    expect(a.certification.status).toBe('NOT_READY')
  })

  it('RC-03: a rate in another currency and a rate without a basis each fail with their own code', () => {
    const currency = auditHotel(input([plan({ rateCurrency: 'USD' })]))
    expect(codes(currency.plans)).toContain('RATE_CURRENCY_MISMATCH')
    const basis = auditHotel(input([plan({ basis: null })]))
    expect(codes(basis.plans)).toContain('RATE_BASIS_UNVERIFIED')
    expect(basis.plans[0].amountBasis).toBe('UNVERIFIED')
    expect(basis.certification.status).toBe('NOT_READY')
  })

  it('RC-04: NET rates fail without an ACTIVE markup rule and pass with one', () => {
    const without = auditHotel(input([plan({ basis: 'NET' })]))
    expect(codes(without.plans)).toContain('NET_MARKUP_MISSING')
    expect(without.plans[0].rowClasses.BLOCKED_NO_MARKUP).toBe(5)
    const withRule = auditHotel(input([plan({ basis: 'NET' })], { markupRules: [NET_RULE] }))
    expect(withRule.plans[0]).toMatchObject({ status: 'PASS', amountBasis: 'NET' })
    expect(withRule.certification.status).toBe('CERTIFIED')
  })

  it('RC-05: rows for another occupancy are dead data and outside-validity rows are never sold; both only warn', () => {
    const dead = auditHotel(input([plan({ rateOccupancy: 3, occupancy: 2 }), plan({ id: 'plan-2', code: 'RP-OTHER', occupancy: 2 })]))
    const first = dead.plans.find((p) => p.ratePlanId === 'plan-1')!
    expect(first.rowClasses.DEAD).toBe(5)
    expect(first.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['RATE_OTHER_OCCUPANCY', 'NO_PRICED_NIGHTS']))
    const outside = auditHotel(input([plan({ validFrom: '2030-06-03' })]))
    expect(outside.plans[0].rowClasses.OUTSIDE_CONTRACT).toBe(2)
    expect(outside.plans[0].findings.find((f) => f.code === 'RATE_OUTSIDE_CONTRACT')?.severity).toBe('WARN')
  })

  it('RC-06: a rate gap inside validity warns, the hotel is READY_WITH_WARNINGS, and the missing dates are sampled', () => {
    const a = auditHotel(input([plan({ rateDates: dates.slice(0, 3) })]))
    const gap = a.plans[0].findings.find((f) => f.code === 'RATE_GAPS')!
    expect(gap).toMatchObject({ severity: 'WARN', count: 2, sample: dates.slice(3) })
    expect(a.plans[0].status).toBe('WARN')
    expect(a.certification.status).toBe('READY_WITH_WARNINGS')
  })

  it('RC-07: an inactive plan is reported but never certified, failed, or counted against the hotel', () => {
    const a = auditHotel(input([plan(), plan({ id: 'plan-2', status: 'SUSPENDED', amount: 0n, rateCurrency: 'USD' })]))
    const inactive = a.plans.find((p) => p.ratePlanId === 'plan-2')!
    expect(inactive).toMatchObject({ live: false, status: 'PASS' })
    expect(inactive.findings.map((f) => f.code)).toEqual(['PLAN_NOT_LIVE'])
    expect(a.certification).toMatchObject({ status: 'CERTIFIED', plans: { total: 2, live: 1 } })
    expect(remediationItems(a.plans)).toEqual([])
  })

  it('RC-08: duplicate codes across contracts and logical duplicates under different codes both fail, and nothing is merged', () => {
    const a = auditHotel(input([plan({ id: 'p1', code: 'RP-A', contractId: 'c1' }), plan({ id: 'p2', code: 'RP-A', contractId: 'c2' }), plan({ id: 'p3', code: 'RP-B', contractId: 'c1' })]))
    const byId = (id: string) => a.plans.find((p) => p.ratePlanId === id)!.findings.map((f) => f.code)
    expect(byId('p1')).toEqual(expect.arrayContaining(['DUPLICATE_PLAN_CODE', 'DUPLICATE_LOGICAL_PLAN']))
    expect(byId('p2')).toContain('DUPLICATE_PLAN_CODE')
    expect(byId('p2')).not.toContain('DUPLICATE_LOGICAL_PLAN')
    expect(byId('p3')).toContain('DUPLICATE_LOGICAL_PLAN')
    expect(a.plans).toHaveLength(3)
    // different refundability is a different product, not a duplicate
    const distinct = auditHotel(input([plan({ id: 'p1', code: 'RP-A' }), plan({ id: 'p2', code: 'RP-B', refundable: false })]))
    expect(distinct.plans.flatMap((p) => p.findings.map((f) => f.code))).not.toContain('DUPLICATE_LOGICAL_PLAN')
  })

  it('RC-09: code governance warns, offers a suggestion only when it does not collide, and never changes the code', () => {
    const a = auditHotel(input([plan({ id: 'p1', code: 'rp 1_standard' })]))
    expect(a.plans[0].code).toBe('rp 1_standard')
    expect(a.plans[0].findings.find((f) => f.code === 'PLAN_CODE_FORMAT')?.severity).toBe('WARN')
    expect(a.plans[0].suggestedCode).toBe('RP-1-STANDARD')
    const taken = auditHotel(input([plan({ id: 'p1', code: 'rp 1_standard' }), plan({ id: 'p2', code: 'RP-1-STANDARD', contractId: 'c2', boardId: 'b2' })]))
    expect(taken.plans.find((p) => p.ratePlanId === 'p1')!.suggestedCode).toBeNull()
    expect(suggestRatePlanCode('RP-OK')).toBeNull()
    expect(suggestRatePlanCode('***')).toBeNull()
    expect(suggestRatePlanCode('a'.repeat(40))).toHaveLength(32)
  })

  it('RC-10: currency policy, contract currency and occupancy ceiling fail on their own', () => {
    expect(codes(auditHotel(input([plan({ currency: 'USD', contractCurrency: 'USD', rateCurrency: 'USD' })])).plans)).toContain('PLAN_CURRENCY_NOT_ENABLED')
    expect(codes(auditHotel(input([plan({ contractCurrency: 'USD' })])).plans)).toContain('PLAN_CONTRACT_CURRENCY_MISMATCH')
    expect(codes(auditHotel(input([plan({ occupancy: 3 })])).plans)).toContain('OCCUPANCY_EXCEEDS_ROOM')
  })

  it('RC-11: a live plan under a contract that is not ACTIVE fails, and an expiring one warns', () => {
    expect(codes(auditHotel(input([plan({ contractStatus: 'SUSPENDED' })])).plans)).toContain('PLAN_CONTRACT_NOT_ACTIVE')
    expect(codes(auditHotel(input([plan({ validTo: '2030-06-20' })])).plans)).toContain('CONTRACT_EXPIRING')
  })

  it('RC-12: recorded sales markets or nationalities warn that search does not apply them; blank records say nothing', () => {
    expect(codes(auditHotel(input([plan()])).plans)).not.toContain('SALES_MARKETS_NOT_ENFORCED')
    const recorded = auditHotel(input([plan({ salesMarkets: ['GB', 'DE'], nationalities: ['FR'] })]))
    expect(recorded.plans[0].findings.find((f) => f.code === 'SALES_MARKETS_NOT_ENFORCED')).toMatchObject({ severity: 'WARN', count: 3, sample: ['GB', 'DE', 'FR'] })
    expect(codes(auditHotel(input([plan({ salesMarkets: 'not-a-list' })])).plans)).not.toContain('SALES_MARKETS_NOT_ENFORCED')
  })

  it('RC-13: a hotel with no live plan, or one that is not sellable at all, is NOT_READY', () => {
    expect(auditHotel(input([])).certification).toMatchObject({ status: 'NOT_READY', blockers: expect.arrayContaining(['No live rate plan']) })
    const stopped = plan(); stopped.availability.forEach((row) => { row.stopSell = true })
    const a = auditHotel(input([stopped]))
    expect(a.certification.status).toBe('NOT_READY')
    expect(a.plans[0].findings.map((f) => f.code)).toContain('NO_SELLABLE_NIGHTS')
  })

  it('RC-14: classifyRateRow orders the classes and treats the boundary dates of validity as inside', () => {
    const p = plan({ validFrom: '2030-06-02', validTo: '2030-06-04' })
    const row = (day: string, over: Partial<Parameters<typeof classifyRateRow>[1]> = {}) => classifyRateRow(p, { stayDate: at(day), amountMinor: 100n, currency: 'AED', amountBasis: 'SELL', occupancy: 2, ...over }, [])
    expect(row('2030-06-02').rowClass).toBe('VALID')
    expect(row('2030-06-04').rowClass).toBe('VALID')
    expect(row('2030-06-01').rowClass).toBe('OUTSIDE_CONTRACT')
    expect(row('2030-06-05').rowClass).toBe('OUTSIDE_CONTRACT')
    expect(row('2030-06-03', { occupancy: 3, amountMinor: 0n }).rowClass).toBe('DEAD')
    expect(row('2030-06-01', { amountMinor: 0n }).rowClass).toBe('OUTSIDE_CONTRACT')
    expect(row('2030-06-03', { amountMinor: 0n }).reason).toBe('ZERO')
  })

  it('RC-15: the audit is deterministic and never mutates its input', () => {
    const i = input([plan({ amount: 0n }), plan({ id: 'p2', code: 'x y', contractId: 'c2' })], { markupRules: [NET_RULE] })
    const before = structuredClone(i)
    const first = auditHotel(i); const second = auditHotel(i)
    expect(i).toEqual(before)
    expect(JSON.stringify(first.plans)).toBe(JSON.stringify(second.plans))
    expect(first.certification).toEqual(second.certification)
  })

  it('RC-16: remediation is ordered P0, P1, P2 with a suggested action, and covers live plans only', () => {
    const a = auditHotel(input([plan({ id: 'p1', amount: 0n, code: 'bad code', rateDates: dates.slice(0, 4) }), plan({ id: 'p2', code: 'RP-OFF', status: 'DRAFT' })]))
    const items = remediationItems(a.plans)
    expect(items.map((i) => i.priority)).toEqual([...items.map((i) => i.priority)].sort())
    expect(items[0]).toMatchObject({ priority: 'P0', code: 'RATE_AMOUNT_ZERO', ratePlanId: 'p1' })
    expect(items.every((i) => i.suggestedAction.length > 0 && i.ratePlanId === 'p1')).toBe(true)
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })
})

describe('markup rule audit (RC)', () => {
  const rule = (over: Partial<Parameters<typeof auditMarkupRules>[0][number]>) => ({ id: 'r1', scope: 'TENANT_DEFAULT' as const, supplierId: null, hotelId: null, basisPoints: 1000, validFrom: '2030-01-01', validTo: null, status: 'ACTIVE', ...over })

  it('RC-17: zero and very high ACTIVE rules warn; drafts and retired rules are not judged', () => {
    const rows = auditMarkupRules([
      rule({ id: 'zero', basisPoints: 0, validTo: '2030-01-31' }), rule({ id: 'high', basisPoints: 6000, validFrom: '2030-02-01', validTo: '2030-02-28' }),
      rule({ id: 'a', validFrom: '2030-03-01', validTo: '2030-03-31' }),
      rule({ id: 'draft', status: 'DRAFT', basisPoints: 0 }), rule({ id: 'hotel', scope: 'HOTEL', hotelId: 'h1', validFrom: '2030-03-01', validTo: '2030-03-31' }),
    ])
    const by = (id: string) => rows.find((r) => r.id === id)!.findings.map((f) => f.code)
    expect(by('zero')).toEqual(['MARKUP_ZERO_PERCENT'])
    expect(by('high')).toEqual(['MARKUP_VERY_HIGH'])
    expect(by('a')).toEqual([])
    expect(by('draft')).toEqual([]); expect(by('hotel')).toEqual([])
    expect(markupRemediation(rows).every((i) => i.priority === 'P2')).toBe(true)
  })
})

describe('price simulator (RC)', () => {
  const base = (p: AuditPlan, rules: MarkupRuleRow[] = [], over: Partial<Parameters<typeof simulateStay>[0]> = {}) => simulateStay({
    plan: p, mapping: { status: 'MAPPED', hotelId: 'h1' }, roomMapping: { status: 'MAPPED' }, rules, dates: dates.slice(0, 3), checkIn: dates[0], checkOut: dates[3], adults: 2, children: 0, rooms: 1, now: at('2030-05-30'), ...over,
  })

  it('RC-18: a SELL stay is the sum of its nights and reconciles with the evaluator', () => {
    const r = base(plan())
    expect(r).toMatchObject({ eligible: true, reasons: [], totalMinor: '90000', netMinor: '90000', markupMinor: '0', recomputedTotalMinor: '90000', reconciles: true })
    expect(r.nights.map((n) => n.sellMinor)).toEqual(['30000', '30000', '30000'])
  })

  it('RC-19: NET markup is half-up per night and rooms multiply the total, without floating point', () => {
    const p = plan({ basis: 'NET', amount: 30_005n })
    const r = base(p, [NET_RULE], { rooms: 2 })
    // 30005 * 10% = 3000.5 -> 3001 half-up
    expect(r.nights[0]).toMatchObject({ rateMinor: '30005', basis: 'NET', markupBasisPoints: 1000, markupMinor: '3001', sellMinor: '33006' })
    expect(r).toMatchObject({ eligible: true, totalMinor: String(33006 * 3 * 2), markupMinor: String(3001 * 3 * 2), netMinor: String(30005 * 3 * 2), reconciles: true })
  })

  it('RC-20: a NET stay with no markup rule is refused, shows no sell price and prices nothing', () => {
    const r = base(plan({ basis: 'NET' }))
    expect(r.eligible).toBe(false)
    expect(r.reasons).toContain('NET_RATE_MARKUP_UNAVAILABLE')
    expect(r).toMatchObject({ totalMinor: null, recomputedTotalMinor: null, reconciles: true })
    expect(r.nights.every((n) => n.sellMinor === null)).toBe(true)
  })

  it('RC-21: a missing night, a closed night and a wrong party size refuse with the evaluator reasons and no total', () => {
    expect(base(plan({ rateDates: [dates[0], dates[2]] })).reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
    const stopped = plan(); stopped.availability[1].stopSell = true
    expect(base(stopped).reasons).toContain('STOP_SELL')
    const wrongParty = base(plan(), [], { adults: 1 })
    expect(wrongParty.eligible).toBe(false); expect(wrongParty.totalMinor).toBeNull()
  })

  it('RC-22: simulating twice gives the same answer and does not change the plan', () => {
    const p = plan({ basis: 'NET' }); const before = structuredClone(p)
    expect(base(p, [NET_RULE])).toEqual(base(p, [NET_RULE]))
    expect(p).toEqual(before)
  })
})
