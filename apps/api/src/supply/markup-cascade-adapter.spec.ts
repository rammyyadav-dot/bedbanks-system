import { markupMinor } from '@bedbanks/pricing'
import { resolveMarkupBasisPoints, type MarkupRuleRow } from './markup-rules'
import { priceViaCascade } from './markup-cascade-adapter'

const rule = (patch: Partial<MarkupRuleRow>): MarkupRuleRow => ({ scope: 'TENANT_DEFAULT', supplierId: null, hotelId: null, basisPoints: 1_000, validFrom: '2026-01-01', validTo: null, ...patch })
const target = { supplierId: 's1', hotelId: 'h1' }

describe('legacy markup rules priced through the cascade engine (ADR 0080 phase 1)', () => {
  const ruleSets: Record<string, MarkupRuleRow[]> = {
    none: [],
    default: [rule({})],
    stacked: [rule({}), rule({ scope: 'SUPPLIER', supplierId: 's1', basisPoints: 1_500 }), rule({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 2_000 })],
    client: [rule({}), rule({ agencyId: 'a1', basisPoints: 700 }), rule({ market: 'IN', basisPoints: 900 })],
    ended: [rule({}), rule({ scope: 'HOTEL', hotelId: 'h1', basisPoints: 2_000, validTo: '2026-06-30' })],
    excluded: [rule({ excludedHotelIds: ['h1'] })],
  }
  const buyers = [undefined, { agencyId: 'a1', market: 'IN' }, { agencyId: null, market: 'IN' }, { agencyId: 'zz', market: 'AE' }]
  const nets = [1n, 2n, 99n, 10_005n, 45_000n, 9_007_199_254_740_993n]

  it('gives the same sell price, markup and refusal as the live resolver for every rule set, buyer and net', () => {
    for (const [name, rules] of Object.entries(ruleSets)) for (const buyer of buyers) for (const date of ['2026-05-01', '2026-10-15']) for (const net of nets) {
      const bp = resolveMarkupBasisPoints(rules, target, date, buyer)
      const via = priceViaCascade(net, rules, target, date, buyer)
      if (bp === null) { expect({ name, via }).toEqual({ name, via: null }); continue }
      expect(via).not.toBeNull()
      expect({ name, markup: via!.markupMinor }).toEqual({ name, markup: markupMinor(net, bp) })
      expect(via!.sellMinor).toBe(net + markupMinor(net, bp))
      expect(via!.trace).toHaveLength(1)
    }
  })

  it('a client or market rule is traced on the CLIENT layer, a generic rule on SUPPLIER_CONTRACT', () => {
    expect(priceViaCascade(10_000n, ruleSets.client!, target, '2026-10-15', { agencyId: 'a1', market: 'IN' })!.trace[0]!.layer).toBe('CLIENT')
    expect(priceViaCascade(10_000n, ruleSets.stacked!, target, '2026-10-15')!.trace[0]!.layer).toBe('SUPPLIER_CONTRACT')
  })
})
