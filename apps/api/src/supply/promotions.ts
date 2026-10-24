/**
 * Rate plan promotions (ADR 0058, S10a). Pure: no I/O, no clock.
 *
 * At most ONE promotion applies to a stay: the one that saves the buyer the most on that stay, ties to the lowest id. ADR 0067 F-09: promotions the
 * hotel marks `combinable` may also stack: every applicable combinable promotion in turn (FREE_NIGHTS first, then by id), each on what the previous
 * left. The buyer gets whichever of the best single promotion and that stack saves more (the single wins a tie). A promotion with stay window mode
 * NIGHTS_IN_WINDOW discounts only the stay nights inside its window (one such night is enough); WHOLE_STAY needs every night inside it. Discount
 * base ROOM_ONLY discounts the room rate but not the extra-guest lines.
 * Percent promotions discount each night's net half up and never take a night below 1 minor unit; FREE_NIGHTS zeroes the cheapest nights (ties: the
 * later date) and the stay must keep at least one paid night. Booking lead is whole days from today in the HOTEL's calendar to check-in; an unknown
 * today means any promotion that depends on it does not apply. All amounts are integer minor units (bigint).
 */
import { markupMinor } from '@bedbanks/pricing'

export type PromotionKind = 'EARLY_BIRD' | 'LAST_MINUTE' | 'LONG_STAY' | 'FREE_NIGHTS'
export const PROMOTION_KINDS: readonly PromotionKind[] = ['EARLY_BIRD', 'LAST_MINUTE', 'LONG_STAY', 'FREE_NIGHTS']
/**
 * ADR 0089: the kinds a hotel deal adds. A plan promotion keeps the four stored kinds above; only a deal carries these. STAY_X_PAY_Y is FREE_NIGHTS and
 * EARLY_BIRD is EARLY_BIRD, so a deal needs no more than these five new engine kinds.
 */
export type EngineKind = PromotionKind | 'PERCENT_OFF' | 'FLASH_SALE' | 'SUBSEQUENT_NIGHTS' | 'EVERY_NTH_FREE' | 'FIXED_OFF'
export const MAX_PERCENT_BP = 9000
export const MAX_PROMOTIONS_PER_PLAN = 20

/**
 * ADR 0089: what only a hotel deal carries. Absent on a plan promotion, which therefore behaves exactly as before. Every list is an allow-list: empty
 * restricts nothing, a non-empty list fails closed when the buyer attribute is unknown.
 */
export interface DealTerms {
  /** FIXED_OFF: integer minor units in `currency`, per night or once per stay. */
  amountMinor: bigint | null; currency: string | null; amountScope: 'PER_NIGHT' | 'PER_STAY' | null
  /** SUBSEQUENT_NIGHTS: the first discounted night of the stay, counted from 1 (so 2 means night 1 is full price). */
  fromNight: number | null
  /** Bit 0 Monday .. bit 6 Sunday of the night's hotel-local date; null means every day. Eligibility is per night. */
  weekdays: number | null
  /** The deal's own effective window, inclusive, judged against the HOTEL's calendar day. An unknown day means the deal does not apply. */
  activeFrom: string | null; activeTo: string | null
  /** Only breaks a tie between equal savings. It never overrides a guard, an eligibility rule or a larger saving. */
  priority: number
  stackingGroup: string | null; incompatibleWith: readonly string[]
  channels: readonly string[]; sourceMarkets: readonly string[]; agencyIds: readonly string[]
  /** Commercial protection. Evaluated on the nights the deal changes; a breach means the deal is not applied and the base rate is sold. */
  maxDiscountBp: number | null; minSellFloorMinor: bigint | null; minMarginBp: number | null
}

export interface PromotionRule {
  id: string; kind: EngineKind; name: string
  percentBp: number | null; minLeadDays: number | null; maxLeadDays: number | null; minNights: number | null; freeNights: number | null
  bookFrom: string | null; bookTo: string | null; stayFrom: string | null; stayTo: string | null
  /** ADR 0067 F-09. Absent reads as the defaults: not combinable, WHOLE_STAY, ROOM_AND_GUESTS. */
  combinable?: boolean
  stayWindowMode?: StayWindowMode
  discountBase?: DiscountBase
  /** ADR 0089. Present only on a hotel deal. */
  deal?: DealTerms
}
export type StayWindowMode = 'WHOLE_STAY' | 'NIGHTS_IN_WINDOW'
export type DiscountBase = 'ROOM_AND_GUESTS' | 'ROOM_ONLY'
export const STAY_WINDOW_MODES: readonly StayWindowMode[] = ['WHOLE_STAY', 'NIGHTS_IN_WINDOW']
export const DISCOUNT_BASES: readonly DiscountBase[] = ['ROOM_AND_GUESTS', 'ROOM_ONLY']
export interface PromotionContext {
  /** The hotel's calendar day now, YYYY-MM-DD, or null when it cannot be determined. */
  today: string | null
  checkIn: string
  /** The stay's nights in date order, YYYY-MM-DD. */
  dates: readonly string[]
  /** ADR 0089. Who is buying and through which channel. Unknown (absent or null) never satisfies a deal's audience list. */
  buyer?: { market: string | null; agencyId: string | null } | null
  channel?: string | null
  /** ADR 0089. The currency the nightly amounts are in (a FIXED_OFF deal must be in it). */
  currency?: string | null
  /** ADR 0089. Markup basis points per night (same order as `dates`); null for a SELL rate. Needed to judge a sell floor or a margin guard. */
  markups?: ReadonlyArray<number | null>
}
export interface AppliedPromotion {
  id: string; kind: EngineKind; name: string; savingMinor: bigint
  /** ADR 0089: set when the promotion that priced the stay is a hotel deal. `id` is then the deal's id. */
  source?: 'DEAL'
  /** ADR 0067 F-09: when combinable promotions stacked, each of them in the order applied. `id`, `kind` and `name` are then the first's, and `name` joins them. */
  combined?: Array<{ id: string; kind: EngineKind; name: string }>
}

const DAY_MS = 86_400_000
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
export const leadDays = (today: string, checkIn: string): number => dayNumber(checkIn) - dayNumber(today)

const inWindow = (rule: Pick<PromotionRule, 'stayFrom' | 'stayTo'>, day: string) => (rule.stayFrom === null || day >= rule.stayFrom) && (rule.stayTo === null || day <= rule.stayTo)
/** Bit position of a calendar day: 0 Monday .. 6 Sunday (ADR 0089). The day is already the hotel-local date of the night. */
export const weekdayBit = (day: string): number => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7
const weekdayOk = (rule: PromotionRule, day: string) => rule.deal?.weekdays == null || ((rule.deal.weekdays >> weekdayBit(day)) & 1) === 1
const partialMode = (rule: PromotionRule) => (rule.stayWindowMode ?? 'WHOLE_STAY') === 'NIGHTS_IN_WINDOW'
/** One night is discountable by a rule when it is inside a partial stay window (or the mode is whole stay) and on one of the rule's weekdays. */
const nightEligible = (rule: PromotionRule, day: string) => (!partialMode(rule) || inWindow(rule, day)) && weekdayOk(rule, day)
const isFreeKind = (kind: EngineKind) => kind === 'FREE_NIGHTS' || kind === 'EVERY_NTH_FREE'

/** ADR 0089: a deal's own window, channel, market and agency lists. Anything the caller could not establish fails closed. */
function dealGate(rule: PromotionRule, ctx: PromotionContext): boolean {
  const deal = rule.deal
  if (!deal) return true
  if (deal.activeFrom !== null || deal.activeTo !== null) {
    if (ctx.today === null) return false
    if (deal.activeFrom !== null && ctx.today < deal.activeFrom) return false
    if (deal.activeTo !== null && ctx.today > deal.activeTo) return false
  }
  if (deal.channels.length > 0 && (ctx.channel == null || !deal.channels.includes(ctx.channel))) return false
  if (deal.sourceMarkets.length > 0 && (ctx.buyer?.market == null || !deal.sourceMarkets.includes(ctx.buyer.market))) return false
  if (deal.agencyIds.length > 0 && (ctx.buyer?.agencyId == null || !deal.agencyIds.includes(ctx.buyer.agencyId))) return false
  return true
}

export function promotionApplies(rule: PromotionRule, ctx: PromotionContext): boolean {
  const nights = ctx.dates.length
  if (nights < 1) return false
  if (!dealGate(rule, ctx)) return false
  const lead = ctx.today === null ? null : leadDays(ctx.today, ctx.checkIn)
  if (rule.bookFrom !== null || rule.bookTo !== null) {
    if (ctx.today === null) return false
    if (rule.bookFrom !== null && ctx.today < rule.bookFrom) return false
    if (rule.bookTo !== null && ctx.today > rule.bookTo) return false
  }
  if (partialMode(rule)) {
    if (!ctx.dates.some((d) => inWindow(rule, d))) return false
  } else if (!ctx.dates.every((d) => inWindow(rule, d))) return false
  // ADR 0089: a weekday list means at least one night of the stay must fall on one of its days.
  if (rule.deal?.weekdays != null && !ctx.dates.some((d) => weekdayOk(rule, d))) return false
  switch (rule.kind) {
    case 'EARLY_BIRD': return rule.minLeadDays !== null && lead !== null && lead >= rule.minLeadDays
    case 'LAST_MINUTE': return rule.maxLeadDays !== null && lead !== null && lead >= 0 && lead <= rule.maxLeadDays
    case 'LONG_STAY': return rule.minNights !== null && nights >= rule.minNights
    case 'FREE_NIGHTS': return rule.minNights !== null && rule.freeNights !== null && nights >= rule.minNights && rule.freeNights < nights
    case 'PERCENT_OFF': return rule.percentBp !== null && nights >= (rule.minNights ?? 1)
    // A flash sale is a percentage inside a booking window; without both ends of the window it is not a flash sale and does not apply.
    case 'FLASH_SALE': return rule.percentBp !== null && rule.bookFrom !== null && rule.bookTo !== null && nights >= (rule.minNights ?? 1)
    case 'SUBSEQUENT_NIGHTS': return rule.percentBp !== null && rule.deal?.fromNight != null && nights >= rule.deal.fromNight && nights >= (rule.minNights ?? 1)
    case 'EVERY_NTH_FREE': return rule.minNights !== null && nights >= rule.minNights
    case 'FIXED_OFF': return rule.deal != null && rule.deal.amountMinor !== null && rule.deal.amountMinor > 0n && rule.deal.currency !== null && ctx.currency != null && rule.deal.currency === ctx.currency && nights >= (rule.minNights ?? 1)
  }
}

/**
 * The nightly nets after one promotion. `nets` are the per-night nets before it (each >= 1). `bases` (same length) are the part of each night the
 * promotion may discount when its base is ROOM_ONLY (the room rate without guest lines); omitted, the whole net is the base. Nights outside a
 * NIGHTS_IN_WINDOW promotion's window (or off a deal's weekdays) are untouched. Pure arithmetic; the caller decides whether the rule applies.
 */
export function discountedNets(rule: PromotionRule, nets: readonly bigint[], dates: readonly string[], bases?: readonly bigint[]): bigint[] {
  const eligible = (i: number) => nightEligible(rule, dates[i]!)
  const base = (i: number) => (rule.discountBase === 'ROOM_ONLY' && bases ? (bases[i]! < nets[i]! ? bases[i]! : nets[i]!) : nets[i]!)
  if (isFreeKind(rule.kind)) {
    // FREE_NIGHTS: a fixed number of nights, once. EVERY_NTH_FREE: one night per full block of N nights (ADR 0089).
    const freeCount = rule.kind === 'FREE_NIGHTS' ? (rule.freeNights ?? 0) : rule.minNights ? Math.floor(nets.length / rule.minNights) : 0
    const candidates = [...nets.keys()].filter(eligible)
    const free = new Set(candidates.sort((a, b) => (nets[a]! === nets[b]! ? (dates[b]! < dates[a]! ? -1 : 1) : nets[a]! < nets[b]! ? -1 : 1)).slice(0, freeCount))
    // A free night waives its base: with ROOM_ONLY the guest lines of that night are still paid.
    return nets.map((net, i) => (free.has(i) ? net - base(i) : net))
  }
  if (rule.kind === 'FIXED_OFF') {
    const amount = rule.deal?.amountMinor ?? 0n
    const nights = [...nets.keys()].filter(eligible)
    const out = [...nets]
    if (nights.length === 0 || amount <= 0n) return out
    // Per stay: split the amount over the eligible nights in integers, the first nights taking the remainder. Per night: the full amount on each.
    const count = BigInt(nights.length)
    const share = (k: number): bigint => (rule.deal?.amountScope === 'PER_STAY' ? amount / count + (BigInt(k) < amount % count ? 1n : 0n) : amount)
    nights.forEach((i, k) => {
      // Never below 1 minor unit, and with ROOM_ONLY never more than the room rate. A capped night simply takes less; nothing is moved to another night.
      const room = base(i)
      let cap = nets[i]! - 1n
      if (room < cap) cap = room
      if (cap < 0n) cap = 0n
      const give = share(k)
      out[i] = nets[i]! - (give > cap ? cap : give)
    })
    return out
  }
  const bp = BigInt(rule.percentBp ?? 0)
  // SUBSEQUENT_NIGHTS: night 1 is counted from the first night of the stay; the nights before `fromNight` keep their price.
  const first = rule.kind === 'SUBSEQUENT_NIGHTS' ? (rule.deal?.fromNight ?? 2) - 1 : 0
  return nets.map((net, i) => {
    if (!eligible(i) || i < first) return net
    let discount = (base(i) * bp + 5000n) / 10000n
    if (discount > net - 1n) discount = net - 1n
    return net - (discount < 0n ? 0n : discount)
  })
}

const sum = (values: readonly bigint[]): bigint => values.reduce((total, value) => total + value, 0n)

export type GuardBreach = 'MAX_DISCOUNT_EXCEEDED' | 'SELL_FLOOR_BREACHED' | 'MARGIN_BELOW_MINIMUM' | 'GUARD_UNVERIFIABLE'

/**
 * ADR 0089, commercial protection of a deal. Judged on the nights the promotion changed. `before` and `after` are the nightly nets. Sell is the net plus
 * its markup (a SELL rate has none), exactly as the evaluator prices it. A guard that cannot be verified (a SELL rate under a margin guard, or no markup
 * information) is a breach: the deal is not applied and the buyer gets the base rate. Priority and combinability never bypass a guard.
 */
export function guardBreach(rule: PromotionRule, before: readonly bigint[], after: readonly bigint[], ctx: Pick<PromotionContext, 'markups'>): GuardBreach | null {
  const guards = rule.deal
  if (!guards) return null
  const total = sum(before)
  if (guards.maxDiscountBp !== null && (total - sum(after)) * 10000n > total * BigInt(guards.maxDiscountBp)) return 'MAX_DISCOUNT_EXCEEDED'
  if (guards.minSellFloorMinor === null && guards.minMarginBp === null) return null
  for (let i = 0; i < after.length; i += 1) {
    if (after[i]! >= before[i]!) continue
    const bp = ctx.markups?.[i]
    if (bp === undefined) return 'GUARD_UNVERIFIABLE'
    const markup = bp === null ? 0n : markupMinor(after[i]!, bp)
    const sell = after[i]! + markup
    if (guards.minSellFloorMinor !== null && sell < guards.minSellFloorMinor) return 'SELL_FLOOR_BREACHED'
    if (guards.minMarginBp !== null) {
      if (bp === null) return 'GUARD_UNVERIFIABLE'
      if (markup * 10000n < BigInt(guards.minMarginBp) * sell) return 'MARGIN_BELOW_MINIMUM'
    }
  }
  return null
}

/** Two promotions may not stack when they share a stacking group or either names the other as incompatible (ADR 0089). */
function stackConflict(rule: PromotionRule, used: readonly PromotionRule[]): boolean {
  return used.some((other) => (rule.deal?.stackingGroup != null && rule.deal.stackingGroup === other.deal?.stackingGroup) || rule.deal?.incompatibleWith.includes(other.id) === true || other.deal?.incompatibleWith.includes(rule.id) === true)
}

/** Combinable promotions applied in turn, each on the previous result. Free-night kinds first (they pick the cheapest nights), then by id. */
function stackCombinable(rules: readonly PromotionRule[], nets: readonly bigint[], dates: readonly string[], bases: readonly bigint[] | undefined, ctx: PromotionContext): { rules: PromotionRule[]; nets: bigint[]; conflicted: Set<string>; guarded: Set<string> } {
  const ordered = [...rules].sort((a, b) => isFreeKind(a.kind) === isFreeKind(b.kind) ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : isFreeKind(a.kind) ? -1 : 1)
  let current = [...nets]
  let currentBases = bases ? [...bases] : undefined
  const used: PromotionRule[] = []
  const conflicted = new Set<string>()
  const guarded = new Set<string>()
  for (const rule of ordered) {
    if (stackConflict(rule, used)) { conflicted.add(rule.id); continue }
    const after = discountedNets(rule, current, dates, currentBases)
    if (sum(after) >= sum(current)) continue
    // The guards of every promotion in the stack are judged on the whole stack's price, so adding one can never break another's protection.
    if ([...used, rule].some((member) => guardBreach(member, nets, after, ctx) !== null)) { guarded.add(rule.id); continue }
    // The next promotion's room-only base shrinks by what this one took from it.
    if (currentBases) currentBases = currentBases.map((b, i) => { const taken = current[i]! - after[i]!; return b > taken ? b - taken : 0n })
    current = after; used.push(rule)
  }
  return { rules: used, nets: current, conflicted, guarded }
}

export interface PromotionConsideration {
  id: string; name: string
  outcome: 'APPLIED' | 'NOT_ELIGIBLE' | 'NO_SAVING' | 'GUARD_BREACHED' | 'OUTRANKED' | 'EXCLUDED_BY_STACK_RULE'
  guard?: GuardBreach
  /** Saving of this promotion alone on the nets before any promotion (absent when it did not apply). */
  savingMinor?: bigint
}

/**
 * Chooses the promotion that prices a stay and explains every rule it looked at (ADR 0089). Selection: the largest saving; a tie goes to the higher deal
 * priority, then the lowest id. Promotions flagged combinable may also stack (ADR 0067 F-09), and the buyer gets whichever saves more, the single winning a tie.
 * A promotion whose guard is breached is never a candidate. The same promotion id is considered once.
 */
export function evaluatePromotions(rules: readonly PromotionRule[], ctx: PromotionContext, nets: readonly bigint[], bases?: readonly bigint[]): { selected: { applied: AppliedPromotion; nets: bigint[] } | null; considered: PromotionConsideration[] } {
  const total = sum(nets)
  const considered = new Map<string, PromotionConsideration>()
  const seen = new Set<string>()
  const candidates: Array<{ rule: PromotionRule; nets: bigint[]; saving: bigint }> = []
  for (const rule of rules) {
    if (seen.has(rule.id)) continue
    seen.add(rule.id)
    if (!promotionApplies(rule, ctx)) { considered.set(rule.id, { id: rule.id, name: rule.name, outcome: 'NOT_ELIGIBLE' }); continue }
    const after = discountedNets(rule, nets, ctx.dates, bases)
    const saving = total - sum(after)
    if (saving <= 0n) { considered.set(rule.id, { id: rule.id, name: rule.name, outcome: 'NO_SAVING' }); continue }
    const breach = guardBreach(rule, nets, after, ctx)
    if (breach) { considered.set(rule.id, { id: rule.id, name: rule.name, outcome: 'GUARD_BREACHED', guard: breach, savingMinor: saving }); continue }
    candidates.push({ rule, nets: after, saving })
    considered.set(rule.id, { id: rule.id, name: rule.name, outcome: 'OUTRANKED', savingMinor: saving })
  }
  let best: (typeof candidates)[number] | null = null
  for (const candidate of candidates) {
    if (!best || candidate.saving > best.saving) { best = candidate; continue }
    if (candidate.saving === best.saving) {
      const a = candidate.rule.deal?.priority ?? 0
      const b = best.rule.deal?.priority ?? 0
      if (a > b || (a === b && candidate.rule.id < best.rule.id)) best = candidate
    }
  }
  const stack = stackCombinable(candidates.filter((c) => c.rule.combinable === true).map((c) => c.rule), nets, ctx.dates, bases, ctx)
  for (const id of stack.conflicted) { const entry = considered.get(id); if (entry) considered.set(id, { ...entry, outcome: 'EXCLUDED_BY_STACK_RULE' }) }
  const stackSaving = total - sum(stack.nets)
  const markApplied = (ids: readonly string[]) => { for (const id of ids) { const entry = considered.get(id); if (entry) considered.set(id, { ...entry, outcome: 'APPLIED' }) } }
  if (stack.rules.length > 1 && stackSaving > (best?.saving ?? 0n)) {
    const first = stack.rules[0]!
    markApplied(stack.rules.map((r) => r.id))
    return { selected: { applied: { id: first.id, kind: first.kind, name: stack.rules.map((r) => r.name).join(' + '), savingMinor: stackSaving, ...(stack.rules.some((r) => r.deal) ? { source: 'DEAL' as const } : {}), combined: stack.rules.map((r) => ({ id: r.id, kind: r.kind, name: r.name })) }, nets: stack.nets }, considered: [...considered.values()] }
  }
  if (!best) return { selected: null, considered: [...considered.values()] }
  markApplied([best.rule.id])
  return { selected: { applied: { id: best.rule.id, kind: best.rule.kind, name: best.rule.name, savingMinor: best.saving, ...(best.rule.deal ? { source: 'DEAL' as const } : {}) }, nets: best.nets }, considered: [...considered.values()] }
}

export function selectPromotion(rules: readonly PromotionRule[], ctx: PromotionContext, nets: readonly bigint[], bases?: readonly bigint[]): { applied: AppliedPromotion; nets: bigint[] } | null {
  return evaluatePromotions(rules, ctx, nets, bases).selected
}

export interface PromotionIssue { code: string; message: string }
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/** Validates a plan's whole promotion set on write. Every problem is returned so the operator fixes them in one pass. */
export function validatePromotions(rules: ReadonlyArray<Partial<Record<keyof PromotionRule, unknown>>>): PromotionIssue[] {
  const issues: PromotionIssue[] = []
  if (rules.length > MAX_PROMOTIONS_PER_PLAN) issues.push({ code: 'PROMOTION_TOO_MANY', message: `At most ${MAX_PROMOTIONS_PER_PLAN} promotions per plan.` })
  const names = new Set<string>()
  rules.forEach((rule, i) => {
    const at = `Promotion ${i + 1}`
    const add = (code: string, message: string) => issues.push({ code, message: `${at}: ${message}` })
    if (!PROMOTION_KINDS.includes(rule.kind as PromotionKind)) return add('PROMOTION_KIND_INVALID', 'kind must be EARLY_BIRD, LAST_MINUTE, LONG_STAY or FREE_NIGHTS.')
    const name = typeof rule.name === 'string' ? rule.name.trim() : ''
    if (name.length < 1 || name.length > 80) add('PROMOTION_NAME_INVALID', 'a name of 1 to 80 characters is required (agents see it).')
    else if (names.has(name.toLowerCase())) add('PROMOTION_NAME_DUPLICATE', `the name "${name}" is used twice on this plan.`)
    names.add(name.toLowerCase())
    const kind = rule.kind as PromotionKind
    const percentKind = kind !== 'FREE_NIGHTS'
    if (percentKind && !whole(rule.percentBp, 1, MAX_PERCENT_BP)) add('PROMOTION_PERCENT_INVALID', `the discount must be 1 to ${MAX_PERCENT_BP} basis points (0.01% to ${MAX_PERCENT_BP / 100}%). A free night is a FREE_NIGHTS promotion.`) // no-float-check: display-only
    if (!percentKind && rule.percentBp != null) add('PROMOTION_PERCENT_INVALID', 'a FREE_NIGHTS promotion takes no percentage.')
    if (kind === 'EARLY_BIRD' && (!whole(rule.minLeadDays, 1, 730) || rule.maxLeadDays != null)) add('PROMOTION_LEAD_INVALID', 'an early-bird promotion needs minLeadDays from 1 to 730 and no maxLeadDays.')
    if (kind === 'LAST_MINUTE' && (!whole(rule.maxLeadDays, 0, 365) || rule.minLeadDays != null)) add('PROMOTION_LEAD_INVALID', 'a last-minute promotion needs maxLeadDays from 0 to 365 and no minLeadDays.')
    if ((kind === 'LONG_STAY' || kind === 'FREE_NIGHTS') && !whole(rule.minNights, 2, 365)) add('PROMOTION_NIGHTS_INVALID', 'minNights must be a whole number from 2 to 365.')
    if (kind === 'FREE_NIGHTS' && !(whole(rule.freeNights, 1, 364) && whole(rule.minNights, 2, 365) && (rule.freeNights as number) < (rule.minNights as number))) add('PROMOTION_FREE_NIGHTS_INVALID', 'freeNights must be a whole number below minNights, so the stay keeps a paid night.')
    if (kind !== 'FREE_NIGHTS' && rule.freeNights != null) add('PROMOTION_FREE_NIGHTS_INVALID', 'only a FREE_NIGHTS promotion takes freeNights.')
    if ((kind === 'EARLY_BIRD' || kind === 'LAST_MINUTE') && rule.minNights != null) add('PROMOTION_NIGHTS_INVALID', 'this kind takes no minNights.')
    if (kind === 'EARLY_BIRD' && rule.maxLeadDays != null) add('PROMOTION_LEAD_INVALID', 'an early-bird promotion takes no maxLeadDays.')
    for (const key of ['bookFrom', 'bookTo', 'stayFrom', 'stayTo'] as const) if (rule[key] != null && !isDay(rule[key])) add('PROMOTION_WINDOW_INVALID', `${key} must be a real calendar day (YYYY-MM-DD) or empty.`)
    if (isDay(rule.bookFrom) && isDay(rule.bookTo) && rule.bookTo < rule.bookFrom) add('PROMOTION_WINDOW_INVALID', 'bookTo is before bookFrom.')
    if (isDay(rule.stayFrom) && isDay(rule.stayTo) && rule.stayTo < rule.stayFrom) add('PROMOTION_WINDOW_INVALID', 'stayTo is before stayFrom.')
    // ADR 0067 F-09
    if (rule.combinable != null && typeof rule.combinable !== 'boolean') add('PROMOTION_COMBINABLE_INVALID', 'combinable must be true or false.')
    if (rule.stayWindowMode != null && !STAY_WINDOW_MODES.includes(rule.stayWindowMode as StayWindowMode)) add('PROMOTION_WINDOW_INVALID', 'stayWindowMode must be WHOLE_STAY or NIGHTS_IN_WINDOW.')
    if (rule.stayWindowMode === 'NIGHTS_IN_WINDOW' && rule.stayFrom == null && rule.stayTo == null) add('PROMOTION_WINDOW_INVALID', 'NIGHTS_IN_WINDOW needs a stay window (stayFrom or stayTo).')
    if (rule.discountBase != null && !DISCOUNT_BASES.includes(rule.discountBase as DiscountBase)) add('PROMOTION_BASE_INVALID', 'discountBase must be ROOM_AND_GUESTS or ROOM_ONLY.')
  })
  return issues
}
