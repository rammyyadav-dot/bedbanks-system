import { codesOutsideContract, marketReasons, planMarketReasons, normalizeCountry, parseMarketList, parseMarketRules } from './market-rules'
import { evaluateContractedStay, type ContractedStaySnapshot } from './contracted-sellability'

describe('contract market rules (ADR 0035)', () => {
  describe('parseMarketList', () => {
    it('treats unset, null and empty as unrestricted', () => {
      expect(parseMarketList(undefined)).toEqual([]); expect(parseMarketList(null)).toEqual([]); expect(parseMarketList([])).toEqual([])
    })
    it('normalizes case and whitespace, removes duplicates and sorts', () => {
      expect(parseMarketList([' gb', 'DE', 'GB', 'fr '])).toEqual(['DE', 'FR', 'GB'])
    })
    it.each([['junk'], [{ 0: 'GB' }], [['GBR']], [['G']], [[1]], [['GB', null]], [['G1']], [Array.from({ length: 251 }, (_, i) => `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`)]])('a malformed list is invalid, never silently empty: %p', (value) => {
      expect(parseMarketList(value)).toBeNull()
    })
  })

  describe('marketReasons', () => {
    const open = parseMarketRules({})
    it('an open contract admits every buyer, including an unknown one', () => {
      expect(marketReasons(open, { nationality: null, market: null })).toEqual([])
      expect(marketReasons(open, { nationality: 'IN', market: 'GB' })).toEqual([])
    })
    it('a sales-market list is an allow-list against the buyer market', () => {
      const rules = parseMarketRules({ salesMarkets: ['GB', 'DE'] })
      expect(marketReasons(rules, { nationality: 'IN', market: 'gb' })).toEqual([])
      expect(marketReasons(rules, { nationality: 'IN', market: 'FR' })).toEqual(['SOURCE_MARKET_NOT_ALLOWED'])
    })
    it('an unknown buyer market or nationality fails closed when a list exists', () => {
      expect(marketReasons(parseMarketRules({ salesMarkets: ['GB'] }), { nationality: 'IN', market: null })).toEqual(['SOURCE_MARKET_NOT_ALLOWED'])
      expect(marketReasons(parseMarketRules({ salesMarkets: ['GB'] }), { nationality: 'IN', market: 'GBR' })).toEqual(['SOURCE_MARKET_NOT_ALLOWED'])
      expect(marketReasons(parseMarketRules({ nationalities: ['IN'] }), { nationality: null, market: 'GB' })).toEqual(['NATIONALITY_NOT_ALLOWED'])
      expect(marketReasons(parseMarketRules({ nationalities: ['IN'] }), { nationality: '', market: 'GB' })).toEqual(['NATIONALITY_NOT_ALLOWED'])
    })
    it('both lists must pass', () => {
      const rules = parseMarketRules({ salesMarkets: ['GB'], nationalities: ['IN'] })
      expect(marketReasons(rules, { nationality: 'IN', market: 'GB' })).toEqual([])
      expect(marketReasons(rules, { nationality: 'FR', market: 'DE' })).toEqual(['SOURCE_MARKET_NOT_ALLOWED', 'NATIONALITY_NOT_ALLOWED'])
    })
    it('a malformed list makes the contract unsellable to everyone instead of unrestricted', () => {
      expect(marketReasons(parseMarketRules({ salesMarkets: 'junk' }), { nationality: 'IN', market: 'GB' })).toEqual(['CONTRACT_MARKET_RULE_INVALID'])
      expect(marketReasons(parseMarketRules({ nationalities: [7] }), { nationality: 'IN', market: 'GB' })).toEqual(['CONTRACT_MARKET_RULE_INVALID'])
    })
    it('normalizeCountry accepts only two letters', () => {
      expect([normalizeCountry(' gb '), normalizeCountry('GBR'), normalizeCountry(''), normalizeCountry(null), normalizeCountry(undefined)]).toEqual(['GB', null, null, null, null])
    })
  })

  describe('evaluator', () => {
    const snapshot = (marketRules?: ContractedStaySnapshot['marketRules'], planMarketRules: ContractedStaySnapshot['planMarketRules'] = { salesMarkets: [], nationalities: [] }): ContractedStaySnapshot => ({
      hotelContentStatus: 'COMPLETE', roomActive: true, boardActive: true, supplierStatus: 'ACTIVE', hotelMappingStatus: 'MAPPED', hotelMappingHotelId: 'h', canonicalHotelId: 'h', roomMappingStatus: 'MAPPED',
      contractStatus: 'ACTIVE', contractValidFrom: '2026-01-01', contractValidTo: '2026-12-31', contractCurrency: 'AED', guestPrices: [], cancellationPolicyMissing: false, planMarketRules, ratePlanValidFrom: null, ratePlanValidTo: null, ratePlanStatus: 'ACTIVE', ratePlanOccupancy: 2, ratePlanCurrency: 'AED', ratePlanMinStay: 1, ratePlanMaxStay: null,
      ratePlanReleaseDays: 0, hotelTimeZone: 'Asia/Dubai', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, ...(marketRules ? { marketRules } : {}),
      nights: [{ date: '2026-10-15', rateAmountMinor: 10_000n, rateCurrency: 'AED', amountBasis: 'SELL', availability: { allotment: 4, sold: 0, held: 0, stopSell: false, minStay: 1, closedToArrival: false } }],
    })
    const request = { checkIn: '2026-10-15', checkOut: '2026-10-16', rooms: 1, adults: 2, children: 0, currency: 'AED', now: new Date('2026-10-05T00:00:00.000Z') }

    it('is buyer-independent when the request names no buyer (Admin diagnostics): a restriction never blocks', () => {
      expect(evaluateContractedStay(snapshot(parseMarketRules({ salesMarkets: ['GB'], nationalities: ['IN'] })), request)).toMatchObject({ eligible: true, totalMinor: 10_000n })
      expect(evaluateContractedStay(snapshot(parseMarketRules({ salesMarkets: 'junk' })), request).eligible).toBe(true)
    })
    it('enforces the rules when a buyer is named, with no total on refusal', () => {
      const rules = parseMarketRules({ salesMarkets: ['GB'], nationalities: ['IN'] })
      expect(evaluateContractedStay(snapshot(rules), { ...request, buyer: { nationality: 'IN', market: 'GB' } })).toMatchObject({ eligible: true, totalMinor: 10_000n })
      const refused = evaluateContractedStay(snapshot(rules), { ...request, buyer: { nationality: 'FR', market: 'DE' } })
      expect(refused).toMatchObject({ eligible: false, totalMinor: null, netMinor: null })
      expect(refused.reasons).toEqual(['SOURCE_MARKET_NOT_ALLOWED', 'NATIONALITY_NOT_ALLOWED'])
    })
    it('a snapshot without market rules is open, and a malformed one is refused for a named buyer', () => {
      expect(evaluateContractedStay(snapshot(), { ...request, buyer: { nationality: null, market: null } }).eligible).toBe(true)
      expect(evaluateContractedStay(snapshot(parseMarketRules({ nationalities: 'x' })), { ...request, buyer: { nationality: 'IN', market: 'GB' } }).reasons).toEqual(['CONTRACT_MARKET_RULE_INVALID'])
    })

  describe('plan-level rules (ADR 0057, S3)', () => {
    const buyer = (market: string | null, nationality: string | null) => ({ market, nationality })
    it('uses plan-specific codes so a refusal names its source', () => {
      expect(planMarketReasons({ salesMarkets: ['GB'], nationalities: ['IN'] }, buyer('AE', 'PK'))).toEqual(['RATE_PLAN_SOURCE_MARKET_NOT_ALLOWED', 'RATE_PLAN_NATIONALITY_NOT_ALLOWED'])
      expect(planMarketReasons({ salesMarkets: null, nationalities: [] }, buyer('AE', 'IN'))).toEqual(['RATE_PLAN_MARKET_RULE_INVALID'])
      expect(planMarketReasons({ salesMarkets: [], nationalities: [] }, buyer(null, null))).toEqual([])
    })
    it('lists codes a plan names outside a restricted contract; an unrestricted contract allows anything', () => {
      expect(codesOutsideContract(['AE', 'US'], ['AE', 'IN'])).toEqual(['US'])
      expect(codesOutsideContract(['US'], [])).toEqual([])
    })
    const request = { checkIn: '2026-10-15', checkOut: '2026-10-16', rooms: 1, adults: 2, children: 0, currency: 'AED', now: new Date('2026-10-05T00:00:00.000Z') }
    it('a plan can narrow the contract: the buyer must pass both', () => {
      const contract = parseMarketRules({ salesMarkets: ['AE', 'IN'] })
      const narrowed = snapshot(contract, { salesMarkets: ['AE'], nationalities: [] })
      expect(evaluateContractedStay(narrowed, { ...request, buyer: buyer('AE', 'IN') }).eligible).toBe(true)
      const refused = evaluateContractedStay(narrowed, { ...request, buyer: buyer('IN', 'IN') })
      expect(refused.eligible).toBe(false)
      expect(refused.reasons).toEqual(['RATE_PLAN_SOURCE_MARKET_NOT_ALLOWED']) // the contract allows IN; the plan does not
      expect(refused.totalMinor).toBeNull()
    })
    it('a plan can never widen the contract', () => {
      const contract = parseMarketRules({ salesMarkets: ['AE'] })
      const widened = snapshot(contract, { salesMarkets: ['AE', 'US'], nationalities: [] })
      const refused = evaluateContractedStay(widened, { ...request, buyer: buyer('US', 'US') })
      expect(refused.reasons).toEqual(['SOURCE_MARKET_NOT_ALLOWED'])
    })
    it('an unknown buyer market never satisfies a plan restriction; a malformed plan list refuses everyone', () => {
      const restricted = snapshot(undefined, { salesMarkets: ['AE'], nationalities: [] })
      expect(evaluateContractedStay(restricted, { ...request, buyer: buyer(null, 'IN') }).reasons).toContain('RATE_PLAN_SOURCE_MARKET_NOT_ALLOWED')
      const malformed = snapshot(undefined, parseMarketRules({ salesMarkets: 'junk' }))
      expect(evaluateContractedStay(malformed, { ...request, buyer: buyer('AE', 'IN') }).reasons).toContain('RATE_PLAN_MARKET_RULE_INVALID')
    })
    it('is buyer-independent for Admin diagnostics: a plan restriction never blocks without a buyer', () => {
      expect(evaluateContractedStay(snapshot(undefined, { salesMarkets: ['GB'], nationalities: [] }), request).eligible).toBe(true)
    })
  })
  })
})
