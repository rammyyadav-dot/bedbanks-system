import { classifyMarkupNight } from './markup-impact'
import { resolveMarkupBasisPoints, type MarkupRuleRow } from './markup-rules'

const net = (over: Partial<{ amountMinor: bigint; currency: string; amountBasis: string | null }> = {}) => ({ amountMinor: 10_005n, currency: 'AED', amountBasis: 'NET' as string | null, ...over })

describe('markup impact classification', () => {
  it('prices a NET night with half-up markup, and treats zero basis points as a real rule', () => {
    expect(classifyMarkupNight(net(), 'AED', 1_000)).toEqual({ class: 'net_priced', markupMinor: 1_001n })
    expect(classifyMarkupNight(net(), 'AED', 0)).toEqual({ class: 'net_priced', markupMinor: 0n })
  })
  it('a zero or negative amount, a missing night and a foreign currency are gaps, not priced or stored-sell nights', () => {
    expect(classifyMarkupNight(net({ amountMinor: 0n }), 'AED', 1_000).class).toBe('gap')
    expect(classifyMarkupNight(net({ amountMinor: -1n, amountBasis: 'SELL' }), 'AED', null).class).toBe('gap')
    expect(classifyMarkupNight(undefined, 'AED', 1_000).class).toBe('gap')
    expect(classifyMarkupNight(net({ currency: 'USD' }), 'AED', 1_000).class).toBe('gap')
  })
  it('separates stored sell, an unverified basis, and a NET night with no usable rule', () => {
    expect(classifyMarkupNight(net({ amountBasis: 'SELL' }), 'AED', null).class).toBe('sell')
    expect(classifyMarkupNight(net({ amountBasis: null }), 'AED', 1_000).class).toBe('basis_unverified')
    expect(classifyMarkupNight(net({ amountBasis: '' }), 'AED', 1_000).class).toBe('basis_unverified')
    for (const bp of [null, -1, 10_001, 1.5]) expect(classifyMarkupNight(net(), 'AED', bp).class).toBe('net_unpriced')
  })
  it('without a buyer, an agency-only rule leaves the night unpriced', () => {
    const agency: MarkupRuleRow = { scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints: 1_500, validFrom: '2026-01-01', validTo: null, agencyId: 'agency-1' }
    const bp = resolveMarkupBasisPoints([agency], { supplierId: 's1', hotelId: 'h1' }, '2026-10-15')
    expect(classifyMarkupNight(net(), 'AED', bp).class).toBe('net_unpriced')
  })
  it('keeps an amount past the safe integer range exact', () => {
    const amount = 9_007_199_254_740_993n
    expect(classifyMarkupNight(net({ amountMinor: amount }), 'AED', 10_000)).toEqual({ class: 'net_priced', markupMinor: amount })
  })
})
