import { resolveMarkupBasisPoints, markupResolverFor, rulesNeedBuyer, type MarkupRuleRow } from './markup-rules'

const rule = (patch: Partial<MarkupRuleRow>): MarkupRuleRow => ({ scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints: 1_000, validFrom: '2026-01-01', validTo: null, ...patch })
const target = { supplierId: 's1', hotelId: 'h1' }

describe('markup rule resolution (ADR 0018)', () => {
  it('no rules means no markup, so NET stays unsellable', () => {
    expect(resolveMarkupBasisPoints([], target, '2026-10-15')).toBeNull()
  })

  it('the most specific rule wins: hotel over supplier over tenant default', () => {
    const rules = [rule({ basisPoints: 1_000 }), rule({ scope: 'SUPPLIER', supplierId: 's1', basisPoints: 1_500 }), rule({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 2_000 })]
    expect(resolveMarkupBasisPoints(rules, target, '2026-10-15')).toBe(2_000)
    expect(resolveMarkupBasisPoints(rules, { supplierId: 's1', hotelId: 'other' }, '2026-10-15')).toBe(1_500)
    expect(resolveMarkupBasisPoints(rules, { supplierId: 'other', hotelId: 'other' }, '2026-10-15')).toBe(1_000)
  })

  it('a rule for another supplier or hotel never applies', () => {
    const rules = [rule({ scope: 'SUPPLIER', supplierId: 's2', basisPoints: 900 }), rule({ scope: 'HOTEL', hotelId: 'h2', basisPoints: 800 })]
    expect(resolveMarkupBasisPoints(rules, target, '2026-10-15')).toBeNull()
  })

  it('validity is inclusive on both ends, and an ended hotel rule falls back to the supplier rule', () => {
    const rules = [rule({ scope: 'SUPPLIER', supplierId: 's1', basisPoints: 1_500 }), rule({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 2_000, validFrom: '2026-10-10', validTo: '2026-10-20' })]
    expect(resolveMarkupBasisPoints(rules, target, '2026-10-09')).toBe(1_500)
    expect(resolveMarkupBasisPoints(rules, target, '2026-10-10')).toBe(2_000)
    expect(resolveMarkupBasisPoints(rules, target, '2026-10-20')).toBe(2_000)
    expect(resolveMarkupBasisPoints(rules, target, '2026-10-21')).toBe(1_500)
  })

  it('a rule that has not started or has ended never applies, even with no fallback', () => {
    const rules = [rule({ validFrom: '2026-11-01', validTo: '2026-11-30' })]
    expect(resolveMarkupBasisPoints(rules, target, '2026-10-31')).toBeNull()
    expect(resolveMarkupBasisPoints(rules, target, '2026-12-01')).toBeNull()
  })

  it('a zero-percent rule is a rule: it resolves to 0, not to null', () => {
    expect(resolveMarkupBasisPoints([rule({ basisPoints: 0 })], target, '2026-10-15')).toBe(0)
  })

  it('markupResolverFor binds the plan target and is evaluated per night', () => {
    const f = markupResolverFor([rule({ validTo: '2026-10-15' }), rule({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 3_000, validFrom: '2026-10-16' })], 's1', 'h1')
    expect(f('2026-10-15')).toBe(1_000)
    expect(f('2026-10-16')).toBe(3_000)
  })
})

describe('client and market tiers with exclusions (ADR 0067, F-11)', () => {
  const r = (over: Partial<MarkupRuleRow>): MarkupRuleRow => ({ scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints: 1000, validFrom: '2026-01-01', validTo: null, ...over })
  const target = { supplierId: 's1', hotelId: 'h1' }
  const rules = [r({ basisPoints: 1000 }), r({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 1500 }), r({ market: 'GB', basisPoints: 1200 }), r({ agencyId: 'a1', basisPoints: 800 })]
  it('a client tier outranks a market tier, which outranks a generic rule, whatever the generic rule targets', () => {
    expect(resolveMarkupBasisPoints(rules, target, '2026-06-01', { agencyId: 'a1', market: 'GB' })).toBe(800)
    expect(resolveMarkupBasisPoints(rules, target, '2026-06-01', { agencyId: 'a2', market: 'GB' })).toBe(1200)
    expect(resolveMarkupBasisPoints(rules, target, '2026-06-01', { agencyId: 'a2', market: 'AE' })).toBe(1500)
  })
  it('without a buyer only generic rules apply', () => {
    expect(resolveMarkupBasisPoints(rules, target, '2026-06-01')).toBe(1500)
    expect(rulesNeedBuyer(rules)).toBe(true); expect(rulesNeedBuyer([r({})])).toBe(false)
  })
  it('an exclusion carves a hotel or supplier out, so the next rule applies there', () => {
    const carved = [r({ basisPoints: 1000 }), r({ market: 'GB', basisPoints: 1200, excludedHotelIds: ['h1'] })]
    expect(resolveMarkupBasisPoints(carved, target, '2026-06-01', { agencyId: null, market: 'GB' })).toBe(1000)
    expect(resolveMarkupBasisPoints(carved, { supplierId: 's1', hotelId: 'h2' }, '2026-06-01', { agencyId: null, market: 'GB' })).toBe(1200)
    expect(resolveMarkupBasisPoints([r({ excludedSupplierIds: ['s1'] })], target, '2026-06-01')).toBeNull()
  })
})

describe('seasonal markup derivation', () => {
  const target = { supplierId: 's1', hotelId: 'h1' }
  const season = (patch: Partial<MarkupRuleRow>): MarkupRuleRow => ({ scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints: 1_000, validFrom: '2026-01-01', validTo: null, ...patch })
  const on = (rules: readonly MarkupRuleRow[], date: string, buyer?: { agencyId: string | null; market: string | null }) => resolveMarkupBasisPoints(rules, target, date, buyer)

  it('an overlapping season of the same rank yields to the later validFrom, and an equal validFrom keeps the first rule', () => {
    const low = season({ basisPoints: 800, validFrom: '2026-01-01', validTo: '2026-10-31' })
    const high = season({ basisPoints: 2_000, validFrom: '2026-06-01', validTo: '2026-08-31' })
    expect(on([low, high], '2026-05-31')).toBe(800)
    expect(on([low, high], '2026-06-01')).toBe(2_000)
    expect(on([low, high], '2026-08-31')).toBe(2_000)
    expect(on([low, high], '2026-09-01')).toBe(800)
    const first = season({ basisPoints: 1_100, validFrom: '2026-06-01' })
    const sameStart = season({ basisPoints: 1_900, validFrom: '2026-06-01' })
    expect(on([first, sameStart], '2026-06-01')).toBe(1_100)
    expect(on([sameStart, first], '2026-06-01')).toBe(1_900)
  })

  it('a season that has not started does not hide the season underneath it, including a client tier', () => {
    const supplier = season({ scope: 'SUPPLIER', supplierId: 's1', basisPoints: 1_000, validTo: null })
    const hotelHigh = season({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 2_500, validFrom: '2026-10-16', validTo: '2026-10-31' })
    const clientPeak = season({ scope: 'HOTEL', hotelId: 'h1', agencyId: 'a1', basisPoints: 500, validFrom: '2026-10-17', validTo: '2026-10-17' })
    const rules = [supplier, hotelHigh, clientPeak]
    const buyer = { agencyId: 'a1', market: 'GB' }
    expect(on(rules, '2026-10-15', buyer)).toBe(1_000)
    expect(on(rules, '2026-10-16', buyer)).toBe(2_500)
    expect(on(rules, '2026-10-17', buyer)).toBe(500)
    expect(on(rules, '2026-10-18', buyer)).toBe(2_500)
    expect(on(rules, '2026-11-01', buyer)).toBe(1_000)
    expect(on(rules, '2026-10-17')).toBe(2_500)
    expect(on(rules, '2026-10-17', { agencyId: 'a2', market: 'GB' })).toBe(2_500)
  })

  it('a market season applies only to that market, and a zero-percent season is still a season', () => {
    const generic = season({ basisPoints: 1_000 })
    const gbSummer = season({ market: 'GB', basisPoints: 0, validFrom: '2026-06-01', validTo: '2026-08-31' })
    expect(on([generic, gbSummer], '2026-07-01', { agencyId: null, market: 'GB' })).toBe(0)
    expect(on([generic, gbSummer], '2026-07-01', { agencyId: null, market: 'AE' })).toBe(1_000)
    expect(on([generic, gbSummer], '2026-09-01', { agencyId: null, market: 'GB' })).toBe(1_000)
  })

  it('excluding the hotel from the high season falls back for that hotel only', () => {
    const low = season({ scope: 'SUPPLIER', supplierId: 's1', basisPoints: 1_000 })
    const high = season({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 2_500, validFrom: '2026-10-01', excludedHotelIds: ['h1'] })
    expect(on([low, high], '2026-10-15')).toBe(1_000)
    expect(resolveMarkupBasisPoints([low, { ...high, excludedHotelIds: [], hotelId: 'h2' }], { supplierId: 's1', hotelId: 'h2' }, '2026-10-15')).toBe(2_500)
    expect(resolveMarkupBasisPoints([low, high], { supplierId: 's1', hotelId: 'h2' }, '2026-10-15')).toBe(1_000)
  })

  it('resolves each night of a stay that crosses a season boundary', () => {
    const rules = [
      season({ scope: 'SUPPLIER', supplierId: 's1', basisPoints: 1_000, validTo: '2026-10-16' }),
      season({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 2_500, validFrom: '2026-10-17' }),
    ]
    const f = markupResolverFor(rules, 's1', 'h1')
    expect(['2026-10-15', '2026-10-16', '2026-10-17'].map(f)).toEqual([1_000, 1_000, 2_500])
    expect(f('2026-10-14')).toBe(1_000)
    expect(markupResolverFor([rules[0]!], 's1', 'h1')('2026-10-17')).toBeNull()
  })
})
