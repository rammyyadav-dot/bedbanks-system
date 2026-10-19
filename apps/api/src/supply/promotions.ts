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
export type PromotionKind = 'EARLY_BIRD' | 'LAST_MINUTE' | 'LONG_STAY' | 'FREE_NIGHTS'
export const PROMOTION_KINDS: readonly PromotionKind[] = ['EARLY_BIRD', 'LAST_MINUTE', 'LONG_STAY', 'FREE_NIGHTS']
export const MAX_PERCENT_BP = 9000
export const MAX_PROMOTIONS_PER_PLAN = 20

export interface PromotionRule {
  id: string; kind: PromotionKind; name: string
  percentBp: number | null; minLeadDays: number | null; maxLeadDays: number | null; minNights: number | null; freeNights: number | null
  bookFrom: string | null; bookTo: string | null; stayFrom: string | null; stayTo: string | null
  /** ADR 0067 F-09. Absent reads as the defaults: not combinable, WHOLE_STAY, ROOM_AND_GUESTS. */
  combinable?: boolean
  stayWindowMode?: StayWindowMode
  discountBase?: DiscountBase
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
}
export interface AppliedPromotion {
  id: string; kind: PromotionKind; name: string; savingMinor: bigint
  /** ADR 0067 F-09: when combinable promotions stacked, each of them in the order applied. `id`, `kind` and `name` are then the first's, and `name` joins them. */
  combined?: Array<{ id: string; kind: PromotionKind; name: string }>
}

const DAY_MS = 86_400_000
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
export const leadDays = (today: string, checkIn: string): number => dayNumber(checkIn) - dayNumber(today)

const inWindow = (rule: Pick<PromotionRule, 'stayFrom' | 'stayTo'>, day: string) => (rule.stayFrom === null || day >= rule.stayFrom) && (rule.stayTo === null || day <= rule.stayTo)

export function promotionApplies(rule: PromotionRule, ctx: PromotionContext): boolean {
  const nights = ctx.dates.length
  if (nights < 1) return false
  const lead = ctx.today === null ? null : leadDays(ctx.today, ctx.checkIn)
  if (rule.bookFrom !== null || rule.bookTo !== null) {
    if (ctx.today === null) return false
    if (rule.bookFrom !== null && ctx.today < rule.bookFrom) return false
    if (rule.bookTo !== null && ctx.today > rule.bookTo) return false
  }
  if ((rule.stayWindowMode ?? 'WHOLE_STAY') === 'NIGHTS_IN_WINDOW') {
    if (!ctx.dates.some((d) => inWindow(rule, d))) return false
  } else if (!ctx.dates.every((d) => inWindow(rule, d))) return false
  switch (rule.kind) {
    case 'EARLY_BIRD': return rule.minLeadDays !== null && lead !== null && lead >= rule.minLeadDays
    case 'LAST_MINUTE': return rule.maxLeadDays !== null && lead !== null && lead >= 0 && lead <= rule.maxLeadDays
    case 'LONG_STAY': return rule.minNights !== null && nights >= rule.minNights
    case 'FREE_NIGHTS': return rule.minNights !== null && rule.freeNights !== null && nights >= rule.minNights && rule.freeNights < nights
  }
}

/**
 * The nightly nets after one promotion. `nets` are the per-night nets before it (each >= 1). `bases` (same length) are the part of each night the
 * promotion may discount when its base is ROOM_ONLY (the room rate without guest lines); omitted, the whole net is the base. Nights outside a
 * NIGHTS_IN_WINDOW promotion's window are untouched. Pure arithmetic; the caller decides whether the rule applies.
 */
export function discountedNets(rule: PromotionRule, nets: readonly bigint[], dates: readonly string[], bases?: readonly bigint[]): bigint[] {
  const partial = (rule.stayWindowMode ?? 'WHOLE_STAY') === 'NIGHTS_IN_WINDOW'
  const eligible = (i: number) => !partial || inWindow(rule, dates[i]!)
  const base = (i: number) => (rule.discountBase === 'ROOM_ONLY' && bases ? (bases[i]! < nets[i]! ? bases[i]! : nets[i]!) : nets[i]!)
  if (rule.kind === 'FREE_NIGHTS') {
    const candidates = [...nets.keys()].filter(eligible)
    const free = new Set(candidates.sort((a, b) => (nets[a]! === nets[b]! ? (dates[b]! < dates[a]! ? -1 : 1) : nets[a]! < nets[b]! ? -1 : 1)).slice(0, rule.freeNights ?? 0))
    // A free night waives its base: with ROOM_ONLY the guest lines of that night are still paid.
    return nets.map((net, i) => (free.has(i) ? net - base(i) : net))
  }
  const bp = BigInt(rule.percentBp ?? 0)
  return nets.map((net, i) => {
    if (!eligible(i)) return net
    let discount = (base(i) * bp + 5000n) / 10000n
    if (discount > net - 1n) discount = net - 1n
    return net - (discount < 0n ? 0n : discount)
  })
}

/** Combinable promotions applied in turn, each on the previous result. FREE_NIGHTS first (they pick the cheapest nights), then by id. */
function stackCombinable(rules: readonly PromotionRule[], nets: readonly bigint[], dates: readonly string[], bases?: readonly bigint[]): { rules: PromotionRule[]; nets: bigint[] } {
  const ordered = [...rules].sort((a, b) => (a.kind === 'FREE_NIGHTS') === (b.kind === 'FREE_NIGHTS') ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind === 'FREE_NIGHTS' ? -1 : 1)
  let current = [...nets]
  let currentBases = bases ? [...bases] : undefined
  const used: PromotionRule[] = []
  for (const rule of ordered) {
    const after = discountedNets(rule, current, dates, currentBases)
    if (after.reduce((s, n) => s + n, 0n) >= current.reduce((s, n) => s + n, 0n)) continue
    // The next promotion's room-only base shrinks by what this one took from it.
    if (currentBases) currentBases = currentBases.map((b, i) => { const taken = current[i]! - after[i]!; return b > taken ? b - taken : 0n })
    current = after; used.push(rule)
  }
  return { rules: used, nets: current }
}

export function selectPromotion(rules: readonly PromotionRule[], ctx: PromotionContext, nets: readonly bigint[], bases?: readonly bigint[]): { applied: AppliedPromotion; nets: bigint[] } | null {
  const total = nets.reduce((sum, net) => sum + net, 0n)
  let best: { rule: PromotionRule; nets: bigint[]; saving: bigint } | null = null
  const applicable = rules.filter((rule) => promotionApplies(rule, ctx))
  for (const rule of applicable) {
    const after = discountedNets(rule, nets, ctx.dates, bases)
    const saving = total - after.reduce((sum, net) => sum + net, 0n)
    if (saving <= 0n) continue
    if (!best || saving > best.saving || (saving === best.saving && rule.id < best.rule.id)) best = { rule, nets: after, saving }
  }
  const stack = stackCombinable(applicable.filter((rule) => rule.combinable === true), nets, ctx.dates, bases)
  const stackSaving = total - stack.nets.reduce((sum, net) => sum + net, 0n)
  if (stack.rules.length > 1 && stackSaving > (best?.saving ?? 0n)) {
    const first = stack.rules[0]!
    return { applied: { id: first.id, kind: first.kind, name: stack.rules.map((r) => r.name).join(' + '), savingMinor: stackSaving, combined: stack.rules.map((r) => ({ id: r.id, kind: r.kind, name: r.name })) }, nets: stack.nets }
  }
  return best ? { applied: { id: best.rule.id, kind: best.rule.kind, name: best.rule.name, savingMinor: best.saving }, nets: best.nets } : null
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
