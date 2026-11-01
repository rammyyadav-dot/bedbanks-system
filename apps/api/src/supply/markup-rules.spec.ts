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
