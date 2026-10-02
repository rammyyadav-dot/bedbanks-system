import { resolveMarkupBasisPoints, markupResolverFor, type MarkupRuleRow } from './markup-rules'

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
