import { FEED_BATCH_GUARD, checkRatePromotable, evaluateBatchGuard } from './promotion-rules'

const ok = { profileBasis: 'NET', observation: { taxesIncluded: true as boolean | null, currency: 'AED', netMinor: 41250n as bigint | number }, plan: { taxesIncluded: true, currency: 'AED' }, enabledCurrencies: ['AED'] }

describe('feed rate promotion rules (ADR 0082 decisions 1 and 2)', () => {
  it('passes only a NET, explicitly tax-inclusive, AED, positive rate on a tax-inclusive plan', () => {
    expect(checkRatePromotable(ok)).toBeNull()
    expect(checkRatePromotable({ ...ok, observation: { ...ok.observation, netMinor: 41250 } })).toBeNull()
  })

  it('blocks a profile basis that is not exactly NET, including SELL and undeclared', () => {
    for (const profileBasis of ['SELL', 'net', '', null, undefined]) expect(checkRatePromotable({ ...ok, profileBasis })).toBe('BASIS_NOT_NET')
  })

  it('blocks an unstated or tax-exclusive observation and a plan that is not flagged tax-inclusive; nothing is defaulted', () => {
    expect(checkRatePromotable({ ...ok, observation: { ...ok.observation, taxesIncluded: null } })).toBe('TAX_NOT_STATED_INCLUSIVE')
    expect(checkRatePromotable({ ...ok, observation: { ...ok.observation, taxesIncluded: false } })).toBe('TAX_NOT_STATED_INCLUSIVE')
    expect(checkRatePromotable({ ...ok, plan: { ...ok.plan, taxesIncluded: false } })).toBe('PLAN_TAX_FLAG_NOT_SET')
  })

  it('blocks a currency that is not enabled or not the plan\'s, and a non-positive net', () => {
    expect(checkRatePromotable({ ...ok, observation: { ...ok.observation, currency: 'USD' }, plan: { taxesIncluded: true, currency: 'USD' } })).toBe('CURRENCY_NOT_ENABLED')
    expect(checkRatePromotable({ ...ok, enabledCurrencies: ['AED', 'USD'], observation: { ...ok.observation, currency: 'USD' } })).toBe('CURRENCY_NOT_PLAN_CURRENCY')
    expect(checkRatePromotable({ ...ok, observation: { ...ok.observation, netMinor: 0n } })).toBe('NET_NOT_POSITIVE')
    expect(checkRatePromotable({ ...ok, observation: { ...ok.observation, netMinor: -5 } })).toBe('NET_NOT_POSITIVE')
  })

  it('reports the first broken rule in a fixed order: basis, tax, plan flag, currency, amount', () => {
    expect(checkRatePromotable({ profileBasis: 'SELL', observation: { taxesIncluded: false, currency: 'USD', netMinor: 0 }, plan: { taxesIncluded: false, currency: 'EUR' }, enabledCurrencies: [] })).toBe('BASIS_NOT_NET')
  })
})

describe('feed batch guard', () => {
  const map = (entries: Array<[string, number]>) => new Map(entries.map(([k, v]) => [k, BigInt(v)]))
  const base = map([['p|1', 10_000], ['p|2', 10_000], ['p|3', 10_000], ['p|4', 10_000], ['p|5', 10_000], ['p|6', 10_000], ['p|7', 10_000], ['p|8', 10_000], ['p|9', 10_000], ['p|10', 10_000]])

  it('holds above 30% movement and 20% dropped nights, stricter than the 50% manual-edit guardrail', () => {
    expect(FEED_BATCH_GUARD).toEqual({ maxMoveBp: 3000, maxDroppedNightsBp: 2000 })
  })

  it('lets small moves, new nights and an identical batch through', () => {
    expect(evaluateBatchGuard(base, base)).toMatchObject({ hold: false, reasons: [] })
    const moved = new Map(base); moved.set('p|1', 12_500n); moved.set('p|new', 99_999n)
    expect(evaluateBatchGuard(base, moved)).toMatchObject({ hold: false, largeMoves: 0 })
  })

  it('holds the whole batch when any night moves more than 30% (exactly 30% passes)', () => {
    const edge = new Map(base); edge.set('p|1', 13_000n)
    expect(evaluateBatchGuard(base, edge).hold).toBe(false)
    const over = new Map(base); over.set('p|1', 13_001n)
    expect(evaluateBatchGuard(base, over)).toMatchObject({ hold: true, reasons: ['LARGE_PRICE_MOVE'], largeMoves: 1 })
    const typo = new Map(base); typo.set('p|2', 100n)
    expect(evaluateBatchGuard(base, typo).hold).toBe(true)
  })

  it('holds when more than 20% of previously promoted nights are missing (exactly 20% passes) and when the batch is empty', () => {
    const drop2 = new Map(base); drop2.delete('p|1'); drop2.delete('p|2')
    expect(evaluateBatchGuard(base, drop2)).toMatchObject({ hold: false, droppedNights: 2 })
    const drop3 = new Map(drop2); drop3.delete('p|3')
    expect(evaluateBatchGuard(base, drop3)).toMatchObject({ hold: true, reasons: ['NIGHTS_DROPPED'], droppedNights: 3 })
    expect(evaluateBatchGuard(base, new Map())).toMatchObject({ hold: true, reasons: ['NIGHTS_DROPPED'], droppedNights: 10 })
  })

  it('has nothing to compare against on a first batch', () => {
    expect(evaluateBatchGuard(new Map(), base)).toMatchObject({ hold: false, previousNights: 0 })
  })
})
