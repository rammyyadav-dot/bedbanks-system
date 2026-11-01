import { DEAL_TRANSITIONS, DEAL_STATUSES, canTransition, canonicalDealTerms, dealFingerprint, dealToRule, effectiveDealStatus, maskToWeekdays, parseDealInput, parseMinor, rowToTerms, weekdaysToMask, type DealTermsRow, type DealStatus } from './deal-model'

const CURRENCIES = ['AED']
const valid = (over: Record<string, unknown> = {}) => ({ code: 'SUMMER-26', name: 'Summer special', kind: 'PERCENT_OFF', percentBp: 1000, ratePlanIds: ['rp1'], ...over })
const parse = (body: unknown) => parseDealInput(body, CURRENCIES)
const codes = (body: unknown) => parse(body).issues.map((issue) => issue.code)

describe('parseDealInput: the allow-list and the shape of each kind', () => {
  it('accepts a minimal percentage deal and fills the defaults', () => {
    const { terms, issues } = parse(valid())
    expect(issues).toEqual([])
    expect(terms).toMatchObject({ code: 'SUMMER-26', kind: 'PERCENT_OFF', percentBp: 1000, priority: 0, combinable: false, stayWindowMode: 'WHOLE_STAY', discountBase: 'ROOM_AND_GUESTS', channels: [], sourceMarkets: [], agencyIds: [], weekdays: null, ratePlanIds: ['rp1'] })
  })

  it.each([
    'status', 'tenantId', 'tenant_id', 'approvalId', 'activatedAt', 'version', 'termsFingerprint', 'allowBelowNet', 'belowNetOverride', 'createdById', 'id',
  ])('refuses to mass-assign %s', (field) => {
    expect(codes(valid({ [field]: 'x' }))).toContain('DEAL_FIELD_NOT_ALLOWED')
    expect(parse(valid({ [field]: 'x' })).terms).toBeNull()
  })

  it('only supplier funding exists', () => {
    expect(codes(valid({ fundingSource: 'PLATFORM' }))).toContain('DEAL_FUNDING_UNSUPPORTED')
    expect(codes(valid({ fundingSource: 'SUPPLIER' }))).toEqual([])
  })

  it('refuses the package add-on as unsupported rather than faking it', () => {
    expect(codes(valid({ kind: 'PACKAGE_ADD_ON' }))).toContain('PROMOTION_TYPE_UNSUPPORTED')
    expect(codes(valid({ kind: 'NOPE' }))).toContain('DEAL_KIND_INVALID')
  })

  it('validates the code and name', () => {
    expect(codes(valid({ code: 'x' }))).toContain('DEAL_CODE_INVALID')
    expect(codes(valid({ code: 'has space' }))).toContain('DEAL_CODE_INVALID')
    expect(codes(valid({ name: '' }))).toContain('DEAL_NAME_INVALID')
    expect(codes(valid({ name: 'n'.repeat(81) }))).toContain('DEAL_NAME_INVALID')
  })

  it('percentage kinds need 1 to 9000 basis points and nothing else a kind does not use', () => {
    expect(codes(valid({ percentBp: undefined }))).toContain('DEAL_PERCENT_REQUIRED')
    expect(codes(valid({ percentBp: 0 }))).toContain('DEAL_NUMBER_INVALID')
    expect(codes(valid({ percentBp: 9001 }))).toContain('DEAL_NUMBER_INVALID')
    expect(codes(valid({ percentBp: 10.5 }))).toContain('DEAL_NUMBER_INVALID')
    expect(codes(valid({ freeNights: 1 }))).toContain('DEAL_FREE_NIGHTS_NOT_ALLOWED')
    expect(codes(valid({ amountMinor: '100', currency: 'AED', amountScope: 'PER_NIGHT' }))).toContain('DEAL_AMOUNT_NOT_ALLOWED')
  })

  it('a flash sale needs both ends of its booking window', () => {
    expect(codes(valid({ kind: 'FLASH_SALE' }))).toContain('DEAL_FLASH_WINDOW_REQUIRED')
    expect(codes(valid({ kind: 'FLASH_SALE', bookFrom: '2026-10-01' }))).toContain('DEAL_FLASH_WINDOW_REQUIRED')
    expect(codes(valid({ kind: 'FLASH_SALE', bookFrom: '2026-10-01', bookTo: '2026-10-05' }))).toEqual([])
  })

  it('an early bird needs its lead, and only an early bird takes one', () => {
    expect(codes(valid({ kind: 'EARLY_BIRD' }))).toContain('DEAL_LEAD_INVALID')
    expect(codes(valid({ kind: 'EARLY_BIRD', minLeadDays: 30 }))).toEqual([])
    expect(codes(valid({ minLeadDays: 30 }))).toContain('DEAL_LEAD_INVALID')
  })

  it('stay X pay Y keeps a paid night', () => {
    const base = { kind: 'STAY_X_PAY_Y', percentBp: undefined }
    expect(codes(valid({ ...base, minNights: 3, freeNights: 1 }))).toEqual([])
    expect(codes(valid({ ...base, minNights: 3, freeNights: 3 }))).toContain('DEAL_FREE_NIGHTS_INVALID')
    expect(codes(valid({ ...base, minNights: 1, freeNights: 1 }))).toContain('DEAL_NIGHTS_INVALID')
    expect(codes(valid({ ...base, minNights: 3 }))).toContain('DEAL_FREE_NIGHTS_INVALID')
    expect(codes(valid({ ...base, minNights: 3, freeNights: 1, percentBp: 500 }))).toContain('DEAL_PERCENT_NOT_ALLOWED')
  })

  it('every Nth night free needs N from 2', () => {
    expect(codes(valid({ kind: 'EVERY_NTH_FREE', percentBp: undefined, minNights: 4 }))).toEqual([])
    expect(codes(valid({ kind: 'EVERY_NTH_FREE', percentBp: undefined, minNights: 1 }))).toContain('DEAL_NIGHTS_INVALID')
    expect(codes(valid({ kind: 'EVERY_NTH_FREE', percentBp: undefined, minNights: 4, freeNights: 1 }))).toContain('DEAL_FREE_NIGHTS_NOT_ALLOWED')
  })

  it('subsequent nights needs the first discounted night', () => {
    expect(codes(valid({ kind: 'SUBSEQUENT_NIGHTS' }))).toContain('DEAL_FROM_NIGHT_INVALID')
    expect(codes(valid({ kind: 'SUBSEQUENT_NIGHTS', fromNight: 1 }))).toContain('DEAL_NUMBER_INVALID')
    expect(codes(valid({ kind: 'SUBSEQUENT_NIGHTS', fromNight: 2 }))).toEqual([])
    expect(codes(valid({ fromNight: 2 }))).toContain('DEAL_FROM_NIGHT_INVALID')
  })

  it('a fixed amount is minor units as a string in an enabled currency with a scope', () => {
    const fixed = { kind: 'FIXED_OFF', percentBp: undefined, amountMinor: '5000', currency: 'AED', amountScope: 'PER_NIGHT' }
    expect(parse(valid(fixed)).terms).toMatchObject({ amountMinor: 5000n, currency: 'AED', amountScope: 'PER_NIGHT' })
    expect(codes(valid({ ...fixed, amountMinor: 5000 }))).toContain('DEAL_AMOUNT_INVALID')
    expect(codes(valid({ ...fixed, amountMinor: '50.5' }))).toContain('DEAL_AMOUNT_INVALID')
    expect(codes(valid({ ...fixed, amountMinor: '-5' }))).toContain('DEAL_AMOUNT_INVALID')
    expect(codes(valid({ ...fixed, amountMinor: '0' }))).toContain('DEAL_AMOUNT_INVALID')
    expect(codes(valid({ ...fixed, amountMinor: '1000000001' }))).toContain('DEAL_AMOUNT_INVALID')
    expect(codes(valid({ ...fixed, amountMinor: undefined }))).toContain('DEAL_AMOUNT_REQUIRED')
    expect(codes(valid({ ...fixed, currency: 'USD' }))).toContain('CURRENCY_NOT_ENABLED')
    expect(codes(valid({ ...fixed, amountScope: undefined }))).toContain('DEAL_AMOUNT_SCOPE_INVALID')
  })

  it('dates must be real days, in order', () => {
    expect(codes(valid({ stayFrom: '2026-02-30' }))).toContain('DEAL_DATE_INVALID')
    expect(codes(valid({ activeFrom: '2026-10-05', activeTo: '2026-10-01' }))).toContain('DEAL_DATE_ORDER')
    expect(codes(valid({ stayWindowMode: 'NIGHTS_IN_WINDOW' }))).toContain('DEAL_WINDOW_MODE_INVALID')
  })

  it('normalizes the audience lists and refuses anything else', () => {
    const { terms } = parse(valid({ channels: ['API', 'PORTAL', 'API'], sourceMarkets: ['IN', 'AE'], agencyIds: ['b', 'a'] }))
    expect(terms).toMatchObject({ channels: ['API', 'PORTAL'], sourceMarkets: ['AE', 'IN'], agencyIds: ['a', 'b'] })
    expect(codes(valid({ channels: ['GDS'] }))).toContain('DEAL_LIST_INVALID')
    expect(codes(valid({ sourceMarkets: ['india'] }))).toContain('DEAL_LIST_INVALID')
    expect(codes(valid({ agencyIds: ['x y'] }))).toContain('DEAL_LIST_INVALID')
  })

  it('weekdays become a bit mask; all seven days mean every day', () => {
    expect(parse(valid({ weekdays: [0, 4, 5] })).terms?.weekdays).toBe(weekdaysToMask([0, 4, 5]))
    expect(maskToWeekdays(weekdaysToMask([0, 4, 5]))).toEqual([0, 4, 5])
    expect(parse(valid({ weekdays: [0, 1, 2, 3, 4, 5, 6] })).terms?.weekdays).toBeNull()
    expect(parse(valid({ weekdays: [] })).terms?.weekdays).toBeNull()
    expect(codes(valid({ weekdays: [7] }))).toContain('DEAL_WEEKDAYS_INVALID')
  })

  it('guards have ranges, and a large discount needs a sell floor', () => {
    expect(codes(valid({ maxDiscountBp: 0 }))).toContain('DEAL_NUMBER_INVALID')
    expect(codes(valid({ minSellFloorMinor: '1.5' }))).toContain('DEAL_AMOUNT_INVALID')
    expect(codes(valid({ percentBp: 5001 }))).toContain('DEAL_LARGE_DISCOUNT_NEEDS_FLOOR')
    expect(codes(valid({ percentBp: 5000 }))).toEqual([])
    expect(codes(valid({ percentBp: 6000, minSellFloorMinor: '10000' }))).toEqual([])
  })

  it('needs at least one rate plan and refuses a non-object body', () => {
    expect(codes(valid({ ratePlanIds: [] }))).toContain('DEAL_SCOPE_REQUIRED')
    expect(codes(valid({ ratePlanIds: undefined }))).toContain('DEAL_SCOPE_REQUIRED')
    expect(parse(null).terms).toBeNull()
    expect(parse([]).terms).toBeNull()
    expect(parse('x').issues[0].code).toBe('DEAL_BODY_INVALID')
  })

  it('reports every problem in one pass', () => {
    expect(codes({ kind: 'FIXED_OFF', code: '!', name: '' }).length).toBeGreaterThan(4)
  })
})

describe('parseMinor', () => {
  it('accepts positive decimal strings only, up to the cap', () => {
    expect(parseMinor('1')).toBe(1n)
    expect(parseMinor('1000000000')).toBe(1_000_000_000n)
    for (const bad of ['0', '01', '1e3', ' 1', '1 ', '-1', '1.0', 1, null, undefined, '1000000001', '12345678901234567']) expect(parseMinor(bad)).toBeNull()
  })
})

describe('the state machine', () => {
  const allowed: Array<[DealStatus, DealStatus]> = [
    ['DRAFT', 'PENDING_APPROVAL'], ['DRAFT', 'ARCHIVED'], ['PENDING_APPROVAL', 'APPROVED'], ['PENDING_APPROVAL', 'REJECTED'], ['PENDING_APPROVAL', 'DRAFT'], ['APPROVED', 'ACTIVE'], ['APPROVED', 'SCHEDULED'],
    ['APPROVED', 'DRAFT'], ['REJECTED', 'DRAFT'], ['SCHEDULED', 'ACTIVE'], ['ACTIVE', 'PAUSED'], ['PAUSED', 'ACTIVE'], ['ACTIVE', 'SUSPENDED'], ['SUSPENDED', 'DRAFT'], ['ACTIVE', 'EXPIRED'], ['EXPIRED', 'ARCHIVED'],
  ]
  it.each(allowed)('allows %s to %s', (from, to) => { expect(canTransition(from, to)).toBe(true) })

  it('never skips the approval: nothing but APPROVED, PAUSED and SCHEDULED reaches a selling state', () => {
    for (const from of DEAL_STATUSES) for (const to of ['ACTIVE', 'SCHEDULED'] as const) if (canTransition(from, to)) expect(['APPROVED', 'PAUSED', 'SCHEDULED']).toContain(from)
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(false)
    expect(canTransition('PENDING_APPROVAL', 'ACTIVE')).toBe(false)
    expect(canTransition('REJECTED', 'ACTIVE')).toBe(false)
    expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(false)
    expect(canTransition('EXPIRED', 'ACTIVE')).toBe(false)
  })

  it('archived is final and expired only archives', () => {
    expect(DEAL_TRANSITIONS.ARCHIVED).toEqual([])
    expect(DEAL_TRANSITIONS.EXPIRED).toEqual(['ARCHIVED'])
  })

  it('a live deal always has a way to stop selling', () => {
    for (const live of ['SCHEDULED', 'ACTIVE', 'PAUSED'] as const) expect(canTransition(live, 'SUSPENDED')).toBe(true)
  })

  it('has an entry for every status', () => { expect(Object.keys(DEAL_TRANSITIONS).sort()).toEqual([...DEAL_STATUSES].sort()) })
})

describe('effectiveDealStatus: what applies today in the hotel calendar', () => {
  const at = (status: DealStatus, activeFrom: string | null, activeTo: string | null, today: string | null) => effectiveDealStatus({ status, activeFrom, activeTo }, today)
  it('a scheduled deal whose start has come reads ACTIVE, and a started one before its start reads SCHEDULED', () => {
    expect(at('SCHEDULED', '2026-11-01', null, '2026-10-31')).toBe('SCHEDULED')
    expect(at('SCHEDULED', '2026-11-01', null, '2026-11-01')).toBe('ACTIVE')
    expect(at('ACTIVE', '2026-11-01', null, '2026-10-31')).toBe('SCHEDULED')
  })
  it('a deal past its last day reads EXPIRED, including a paused one; the last day itself still counts', () => {
    expect(at('ACTIVE', null, '2026-11-30', '2026-11-30')).toBe('ACTIVE')
    expect(at('ACTIVE', null, '2026-11-30', '2026-12-01')).toBe('EXPIRED')
    expect(at('PAUSED', null, '2026-11-30', '2026-12-01')).toBe('EXPIRED')
    expect(at('SCHEDULED', '2026-12-05', '2026-12-10', '2026-12-11')).toBe('EXPIRED')
  })
  it('other states are never rewritten, and an unknown day keeps the stored status', () => {
    expect(at('DRAFT', null, '2020-01-01', '2026-01-01')).toBe('DRAFT')
    expect(at('SUSPENDED', null, '2020-01-01', '2026-01-01')).toBe('SUSPENDED')
    expect(at('ACTIVE', null, '2020-01-01', null)).toBe('ACTIVE')
  })
})

describe('fingerprint', () => {
  const terms = (): DealTermsRow => parse(valid({ channels: ['PORTAL'], ratePlanIds: ['b', 'a'] })).terms!
  it('is stable and independent of the order of lists', () => {
    const a = terms()
    const b = { ...terms(), ratePlanIds: ['a', 'b'], channels: ['PORTAL'] }
    expect(dealFingerprint('h1', a)).toBe(dealFingerprint('h1', b))
    expect(dealFingerprint('h1', a)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('changes with any commercial term, the hotel and the scope', () => {
    const base = dealFingerprint('h1', terms())
    expect(dealFingerprint('h2', terms())).not.toBe(base)
    expect(dealFingerprint('h1', { ...terms(), percentBp: 1001 })).not.toBe(base)
    expect(dealFingerprint('h1', { ...terms(), ratePlanIds: ['a'] })).not.toBe(base)
    expect(dealFingerprint('h1', { ...terms(), minSellFloorMinor: 1n })).not.toBe(base)
    expect(dealFingerprint('h1', { ...terms(), activeTo: '2026-12-31' })).not.toBe(base)
    expect(dealFingerprint('h1', { ...terms(), channels: [] })).not.toBe(base)
  })
  it('writes money as decimal text, never a number', () => {
    expect(canonicalDealTerms('h1', { ...terms(), minSellFloorMinor: 12345678901234n })).toContain('"minSellFloorMinor":"12345678901234"')
  })
})

describe('mapping to the evaluator', () => {
  it('turns a deal into a rule under its own id, with STAY_X_PAY_Y priced as free nights', () => {
    const { terms } = parse(valid({ kind: 'STAY_X_PAY_Y', percentBp: undefined, minNights: 3, freeNights: 1, channels: ['PORTAL'], weekdays: [4, 5], priority: 7, maxDiscountBp: 3000 }))
    const rule = dealToRule('deal-9', terms!)
    expect(rule).toMatchObject({ id: 'deal-9', kind: 'FREE_NIGHTS', minNights: 3, freeNights: 1, percentBp: null, combinable: false })
    expect(rule.deal).toMatchObject({ channels: ['PORTAL'], weekdays: weekdaysToMask([4, 5]), priority: 7, maxDiscountBp: 3000, amountMinor: null })
  })

  it('round-trips a stored row to the same terms', () => {
    const { terms } = parse(valid({ kind: 'FIXED_OFF', percentBp: undefined, amountMinor: '2500', currency: 'AED', amountScope: 'PER_STAY', sourceMarkets: ['IN'], activeFrom: '2026-10-01', stayFrom: '2026-11-01', stayTo: '2026-11-30', ratePlanIds: ['rp2', 'rp1'] }))
    const row = { ...terms!, bookFrom: null, bookTo: null, stayFrom: new Date('2026-11-01T00:00:00Z'), stayTo: new Date('2026-11-30T00:00:00Z'), activeFrom: new Date('2026-10-01T00:00:00Z'), activeTo: null }
    expect(rowToTerms(row as never, ['rp2', 'rp1'])).toEqual({ ...terms, ratePlanIds: ['rp1', 'rp2'] })
  })
})
