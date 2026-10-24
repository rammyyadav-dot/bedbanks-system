import { createHash } from 'node:crypto'
import type { DealTerms, EngineKind, PromotionRule, StayWindowMode, DiscountBase } from './promotions'

/**
 * Hotel deals (ADR 0089). Pure: no I/O, no clock. The input parser (an allow-list, so a body can never set status, tenant, approval or override fields),
 * the shape rules that mirror the database CHECKs, the lifecycle state machine that mirrors the database trigger, the fingerprint an approval is bound to,
 * and the mapping from a stored deal to the evaluator's `PromotionRule`. All amounts are integer minor units (bigint); a percentage is basis points.
 */

export const DEAL_KINDS = ['PERCENT_OFF', 'EARLY_BIRD', 'FLASH_SALE', 'STAY_X_PAY_Y', 'SUBSEQUENT_NIGHTS', 'EVERY_NTH_FREE', 'FIXED_OFF'] as const
export type DealKind = (typeof DEAL_KINDS)[number]
/** Offered by the product brief but not implementable on existing data: it changes what is sold (a priced inclusion), not the price. Refused, never faked. */
export const UNSUPPORTED_DEAL_KINDS = ['PACKAGE_ADD_ON'] as const

export const DEAL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'EXPIRED', 'ARCHIVED'] as const
export type DealStatus = (typeof DEAL_STATUSES)[number]

export const DEAL_CHANNELS = ['PORTAL', 'API'] as const
export const MAX_DEAL_PLANS = 100
export const MAX_DEAL_PERCENT_BP = 9000
export const MAX_DEAL_AMOUNT_MINOR = 1_000_000_000n
/** A percentage above this needs a minimum sell floor (the same 50% line the rate price guardrail uses for a large change, ADR 0067 F-13). */
export const LARGE_DISCOUNT_BP = 5000

export interface DealTermsRow {
  code: string; name: string; kind: DealKind; priority: number
  percentBp: number | null; amountMinor: bigint | null; currency: string | null; amountScope: 'PER_NIGHT' | 'PER_STAY' | null
  minNights: number | null; freeNights: number | null; fromNight: number | null; minLeadDays: number | null
  bookFrom: string | null; bookTo: string | null; stayFrom: string | null; stayTo: string | null
  /** Bit 0 Monday .. bit 6 Sunday; null means every day. */
  weekdays: number | null
  stayWindowMode: StayWindowMode; discountBase: DiscountBase
  combinable: boolean; stackingGroup: string | null; incompatibleDealIds: string[]
  channels: string[]; sourceMarkets: string[]; agencyIds: string[]
  maxDiscountBp: number | null; minSellFloorMinor: bigint | null; minMarginBp: number | null
  activeFrom: string | null; activeTo: string | null
  publicDescription: string | null; internalNotes: string | null
  ratePlanIds: string[]
}

export interface DealIssue { code: string; field?: string; message: string; severity: 'ERROR' | 'WARNING' }

const ALLOWED_KEYS = new Set([
  'idempotencyKey', 'hotelId', 'expectedVersion', 'code', 'name', 'kind', 'priority', 'percentBp', 'amountMinor', 'currency', 'amountScope', 'minNights', 'freeNights', 'fromNight', 'minLeadDays',
  'bookFrom', 'bookTo', 'stayFrom', 'stayTo', 'weekdays', 'stayWindowMode', 'discountBase', 'combinable', 'stackingGroup', 'incompatibleDealIds', 'channels', 'sourceMarkets', 'agencyIds',
  'maxDiscountBp', 'minSellFloorMinor', 'minMarginBp', 'activeFrom', 'activeTo', 'publicDescription', 'internalNotes', 'ratePlanIds', 'fundingSource',
])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const text = (value: unknown, max: number): string | null | undefined => (value === undefined || value === null ? null : typeof value === 'string' ? (value.trim().length <= max ? value.trim() : undefined) : undefined)

/** Minor units travel as decimal strings (never a JSON number). Returns null for anything else, including a fraction, a sign or an exponent. */
export function parseMinor(value: unknown, max: bigint = MAX_DEAL_AMOUNT_MINOR): bigint | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= max ? parsed : null
}

export function weekdaysToMask(days: readonly number[]): number { return days.reduce((mask, day) => mask | (1 << day), 0) }
export function maskToWeekdays(mask: number | null): number[] { return mask === null ? [] : [0, 1, 2, 3, 4, 5, 6].filter((day) => ((mask >> day) & 1) === 1) }

/**
 * Parses a create or full-replace body. Every problem is returned at once. Unknown fields are refused (400 `DEAL_FIELD_NOT_ALLOWED`), so status, tenant,
 * approval, activation and "below net" fields can never be mass-assigned. `enabledCurrencies` is the platform's enabled settlement currencies.
 */
export function parseDealInput(body: unknown, enabledCurrencies: readonly string[]): { terms: DealTermsRow | null; issues: DealIssue[] } {
  const issues: DealIssue[] = []
  const add = (code: string, field: string, message: string) => issues.push({ code, field, message, severity: 'ERROR' })
  if (!isRecord(body)) return { terms: null, issues: [{ code: 'DEAL_BODY_INVALID', message: 'A JSON object is required.', severity: 'ERROR' }] }
  for (const key of Object.keys(body)) if (!ALLOWED_KEYS.has(key)) add('DEAL_FIELD_NOT_ALLOWED', key, `${key} cannot be set through this request.`)
  if (body.fundingSource !== undefined && body.fundingSource !== 'SUPPLIER') add('DEAL_FUNDING_UNSUPPORTED', 'fundingSource', 'Only supplier-funded deals are supported: the discount reduces the supplier net.')

  const kindRaw = body.kind
  if (typeof kindRaw === 'string' && (UNSUPPORTED_DEAL_KINDS as readonly string[]).includes(kindRaw)) add('PROMOTION_TYPE_UNSUPPORTED', 'kind', `${kindRaw} is not supported: it changes what is sold, not the price, and no priced inclusion exists in the contract model.`)
  else if (typeof kindRaw !== 'string' || !(DEAL_KINDS as readonly string[]).includes(kindRaw)) add('DEAL_KIND_INVALID', 'kind', `kind must be one of ${DEAL_KINDS.join(', ')}.`)
  const kind = (DEAL_KINDS as readonly string[]).includes(kindRaw as string) ? (kindRaw as DealKind) : null

  const code = typeof body.code === 'string' ? body.code.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(code)) add('DEAL_CODE_INVALID', 'code', 'code is 2 to 40 letters, digits, hyphens or underscores, starting with a letter or digit.')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name.length < 1 || name.length > 80) add('DEAL_NAME_INVALID', 'name', 'a name of 1 to 80 characters is required (agents see it).')

  const optInt = (field: string, min: number, max: number): number | null => {
    const value = body[field]
    if (value === undefined || value === null) return null
    if (!whole(value, min, max)) { add('DEAL_NUMBER_INVALID', field, `${field} must be a whole number from ${min} to ${max}.`); return null }
    return value
  }
  const optDay = (field: string): string | null => {
    const value = body[field]
    if (value === undefined || value === null || value === '') return null
    if (!isDay(value)) { add('DEAL_DATE_INVALID', field, `${field} must be a real calendar day (YYYY-MM-DD) or empty.`); return null }
    return value
  }
  const optMinor = (field: string, max: bigint): bigint | null => {
    const value = body[field]
    if (value === undefined || value === null || value === '') return null
    const parsed = parseMinor(value, max)
    if (parsed === null) add('DEAL_AMOUNT_INVALID', field, `${field} must be a positive whole number of minor units sent as a string (at most ${max}).`)
    return parsed
  }
  const list = (field: string, max: number, valid: (item: string) => boolean, message: string): string[] => {
    const value = body[field]
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !valid(item.trim()))) { add('DEAL_LIST_INVALID', field, message); return [] }
    // Repeats are harmless and are dropped before the size limit is judged.
    const unique = [...new Set(value.map((item: string) => item.trim()))].sort()
    if (unique.length > max) { add('DEAL_LIST_INVALID', field, message); return [] }
    return unique
  }

  const priority = body.priority === undefined || body.priority === null ? 0 : body.priority
  if (!whole(priority, 0, 100)) add('DEAL_NUMBER_INVALID', 'priority', 'priority must be a whole number from 0 to 100.')
  const percentBp = optInt('percentBp', 1, MAX_DEAL_PERCENT_BP)
  const minNights = optInt('minNights', 1, 365)
  const freeNights = optInt('freeNights', 1, 364)
  const fromNight = optInt('fromNight', 2, 365)
  const minLeadDays = optInt('minLeadDays', 1, 730)
  const amountMinor = optMinor('amountMinor', MAX_DEAL_AMOUNT_MINOR)
  const currencyRaw = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : null
  const amountScope = body.amountScope === undefined || body.amountScope === null ? null : body.amountScope
  if (amountScope !== null && amountScope !== 'PER_NIGHT' && amountScope !== 'PER_STAY') add('DEAL_AMOUNT_SCOPE_INVALID', 'amountScope', 'amountScope must be PER_NIGHT or PER_STAY.')
  const bookFrom = optDay('bookFrom'); const bookTo = optDay('bookTo'); const stayFrom = optDay('stayFrom'); const stayTo = optDay('stayTo')
  const activeFrom = optDay('activeFrom'); const activeTo = optDay('activeTo')
  if (bookFrom && bookTo && bookTo < bookFrom) add('DEAL_DATE_ORDER', 'bookTo', 'bookTo is before bookFrom.')
  if (stayFrom && stayTo && stayTo < stayFrom) add('DEAL_DATE_ORDER', 'stayTo', 'stayTo is before stayFrom.')
  if (activeFrom && activeTo && activeTo < activeFrom) add('DEAL_DATE_ORDER', 'activeTo', 'activeTo is before activeFrom.')

  let weekdays: number | null = null
  if (body.weekdays !== undefined && body.weekdays !== null) {
    if (!Array.isArray(body.weekdays) || body.weekdays.some((day) => !whole(day, 0, 6))) add('DEAL_WEEKDAYS_INVALID', 'weekdays', 'weekdays is a list of 0 (Monday) to 6 (Sunday).')
    else if (body.weekdays.length > 0 && new Set(body.weekdays as number[]).size < 7) weekdays = weekdaysToMask(body.weekdays as number[])
  }
  const stayWindowMode = body.stayWindowMode === undefined ? 'WHOLE_STAY' : body.stayWindowMode
  if (stayWindowMode !== 'WHOLE_STAY' && stayWindowMode !== 'NIGHTS_IN_WINDOW') add('DEAL_WINDOW_MODE_INVALID', 'stayWindowMode', 'stayWindowMode must be WHOLE_STAY or NIGHTS_IN_WINDOW.')
  if (stayWindowMode === 'NIGHTS_IN_WINDOW' && !stayFrom && !stayTo) add('DEAL_WINDOW_MODE_INVALID', 'stayWindowMode', 'NIGHTS_IN_WINDOW needs a stay window.')
  const discountBase = body.discountBase === undefined ? 'ROOM_AND_GUESTS' : body.discountBase
  if (discountBase !== 'ROOM_AND_GUESTS' && discountBase !== 'ROOM_ONLY') add('DEAL_BASE_INVALID', 'discountBase', 'discountBase must be ROOM_AND_GUESTS or ROOM_ONLY.')
  const combinable = body.combinable === undefined ? false : body.combinable
  if (typeof combinable !== 'boolean') add('DEAL_COMBINABLE_INVALID', 'combinable', 'combinable must be true or false.')
  const stackingGroup = body.stackingGroup === undefined || body.stackingGroup === null || body.stackingGroup === '' ? null : body.stackingGroup
  if (stackingGroup !== null && (typeof stackingGroup !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(stackingGroup))) add('DEAL_STACKING_GROUP_INVALID', 'stackingGroup', 'stackingGroup is 1 to 40 letters, digits, hyphens or underscores.')
  const incompatibleDealIds = list('incompatibleDealIds', 20, (item) => /^[A-Za-z0-9_-]{1,64}$/.test(item), 'incompatibleDealIds is a list of at most 20 deal ids.')
  const channels = list('channels', 2, (item) => (DEAL_CHANNELS as readonly string[]).includes(item), `channels is a list of ${DEAL_CHANNELS.join(' and ')}. Other channels are not supported.`)
  const sourceMarkets = list('sourceMarkets', 250, (item) => /^[A-Z]{2}$/.test(item), 'sourceMarkets is a list of ISO-3166 alpha-2 country codes in capitals.')
  const agencyIds = list('agencyIds', 100, (item) => /^[A-Za-z0-9_-]{1,64}$/.test(item), 'agencyIds is a list of at most 100 agency ids.')
  const maxDiscountBp = optInt('maxDiscountBp', 1, MAX_DEAL_PERCENT_BP)
  const minMarginBp = optInt('minMarginBp', 1, MAX_DEAL_PERCENT_BP)
  const minSellFloorMinor = optMinor('minSellFloorMinor', MAX_DEAL_AMOUNT_MINOR)
  const publicDescription = text(body.publicDescription, 500)
  if (publicDescription === undefined) add('DEAL_TEXT_INVALID', 'publicDescription', 'publicDescription is at most 500 characters.')
  const internalNotes = text(body.internalNotes, 2000)
  if (internalNotes === undefined) add('DEAL_TEXT_INVALID', 'internalNotes', 'internalNotes is at most 2000 characters.')
  const planIds = list('ratePlanIds', MAX_DEAL_PLANS, (item) => /^[A-Za-z0-9_-]{1,64}$/.test(item), `ratePlanIds is a list of 1 to ${MAX_DEAL_PLANS} rate plan ids.`)

  // Kind-specific shape (mirrors HotelDeal_kind_check and HotelDeal_kind_fields_check).
  if (kind) {
    const percentKind = kind === 'PERCENT_OFF' || kind === 'EARLY_BIRD' || kind === 'FLASH_SALE' || kind === 'SUBSEQUENT_NIGHTS'
    if (percentKind && percentBp === null) add('DEAL_PERCENT_REQUIRED', 'percentBp', `a ${kind} deal needs percentBp from 1 to ${MAX_DEAL_PERCENT_BP} basis points. A free night is a STAY_X_PAY_Y or EVERY_NTH_FREE deal.`)
    if (!percentKind && body.percentBp != null) add('DEAL_PERCENT_NOT_ALLOWED', 'percentBp', `a ${kind} deal takes no percentage.`)
    if (kind !== 'FIXED_OFF' && (body.amountMinor != null || body.currency != null || body.amountScope != null)) add('DEAL_AMOUNT_NOT_ALLOWED', 'amountMinor', 'amount, currency and amountScope belong to FIXED_OFF deals only.')
    if (kind === 'FIXED_OFF') {
      if (amountMinor === null) add('DEAL_AMOUNT_REQUIRED', 'amountMinor', 'a FIXED_OFF deal needs amountMinor.')
      if (currencyRaw === null || !/^[A-Z]{3}$/.test(currencyRaw) || !enabledCurrencies.includes(currencyRaw)) add('CURRENCY_NOT_ENABLED', 'currency', `currency must be an enabled settlement currency (${enabledCurrencies.join(', ')}).`)
      if (amountScope === null) add('DEAL_AMOUNT_SCOPE_INVALID', 'amountScope', 'a FIXED_OFF deal needs amountScope PER_NIGHT or PER_STAY.')
    }
    if (kind === 'STAY_X_PAY_Y') {
      if (minNights === null || minNights < 2) add('DEAL_NIGHTS_INVALID', 'minNights', 'STAY_X_PAY_Y needs minNights (the X nights you stay) from 2 to 365.')
      if (freeNights === null || (minNights !== null && freeNights >= minNights)) add('DEAL_FREE_NIGHTS_INVALID', 'freeNights', 'freeNights (X minus Y) must be at least 1 and below minNights, so the stay keeps a paid night.')
    } else if (body.freeNights != null) add('DEAL_FREE_NIGHTS_NOT_ALLOWED', 'freeNights', 'only STAY_X_PAY_Y takes freeNights.')
    if (kind === 'EVERY_NTH_FREE' && (minNights === null || minNights < 2)) add('DEAL_NIGHTS_INVALID', 'minNights', 'EVERY_NTH_FREE needs minNights (every Nth night is free) from 2 to 365.')
    if (kind === 'EARLY_BIRD' ? minLeadDays === null : body.minLeadDays != null) add('DEAL_LEAD_INVALID', 'minLeadDays', kind === 'EARLY_BIRD' ? 'an early-bird deal needs minLeadDays from 1 to 730.' : 'only an early-bird deal takes minLeadDays.')
    if (kind === 'SUBSEQUENT_NIGHTS' ? fromNight === null : body.fromNight != null) add('DEAL_FROM_NIGHT_INVALID', 'fromNight', kind === 'SUBSEQUENT_NIGHTS' ? 'a SUBSEQUENT_NIGHTS deal needs fromNight (the first discounted night) from 2 to 365.' : 'only a SUBSEQUENT_NIGHTS deal takes fromNight.')
    if (kind === 'FLASH_SALE' && (!bookFrom || !bookTo)) add('DEAL_FLASH_WINDOW_REQUIRED', 'bookFrom', 'a flash sale needs both bookFrom and bookTo: it is a time-limited booking window.')
  }
  if (amountMinor !== null && minSellFloorMinor !== null && kind === 'FIXED_OFF' && amountMinor >= minSellFloorMinor && amountScope === 'PER_NIGHT') issues.push({ code: 'DEAL_FLOOR_BELOW_DISCOUNT', field: 'minSellFloorMinor', message: 'The per-night discount is not smaller than the minimum sell floor, so the deal can rarely apply.', severity: 'WARNING' })
  if (planIds.length < 1) add('DEAL_SCOPE_REQUIRED', 'ratePlanIds', 'select at least one rate plan.')
  if (percentBp !== null && percentBp > LARGE_DISCOUNT_BP && minSellFloorMinor === null) add('DEAL_LARGE_DISCOUNT_NEEDS_FLOOR', 'minSellFloorMinor', `a discount above ${LARGE_DISCOUNT_BP / 100}% needs a minimum sell floor.`) // no-float-check: display-only
  if (issues.some((issue) => issue.severity === 'ERROR') || !kind) return { terms: null, issues }
  return {
    issues,
    terms: {
      code, name, kind, priority: priority as number, percentBp, amountMinor, currency: kind === 'FIXED_OFF' ? currencyRaw : null, amountScope: kind === 'FIXED_OFF' ? (amountScope as 'PER_NIGHT' | 'PER_STAY') : null,
      minNights, freeNights, fromNight, minLeadDays, bookFrom, bookTo, stayFrom, stayTo, weekdays, stayWindowMode: stayWindowMode as StayWindowMode, discountBase: discountBase as DiscountBase,
      combinable: combinable as boolean, stackingGroup: stackingGroup as string | null, incompatibleDealIds, channels, sourceMarkets, agencyIds, maxDiscountBp, minSellFloorMinor, minMarginBp,
      activeFrom, activeTo, publicDescription: publicDescription ?? null, internalNotes: internalNotes ?? null, ratePlanIds: planIds,
    },
  }
}

// ---- Lifecycle ---------------------------------------------------------------------------------------------------------------------

/** Mirrors the HotelDeal_guard trigger. Anything not listed is refused by the database as well. */
export const DEAL_TRANSITIONS: Readonly<Record<DealStatus, readonly DealStatus[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'ARCHIVED'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT'],
  APPROVED: ['SCHEDULED', 'ACTIVE', 'DRAFT'],
  REJECTED: ['DRAFT', 'ARCHIVED'],
  SCHEDULED: ['ACTIVE', 'PAUSED', 'SUSPENDED', 'EXPIRED'],
  ACTIVE: ['PAUSED', 'SUSPENDED', 'EXPIRED'],
  PAUSED: ['ACTIVE', 'SCHEDULED', 'SUSPENDED', 'EXPIRED', 'ARCHIVED'],
  SUSPENDED: ['DRAFT', 'ARCHIVED'],
  EXPIRED: ['ARCHIVED'],
  ARCHIVED: [],
}
export const canTransition = (from: DealStatus, to: DealStatus): boolean => DEAL_TRANSITIONS[from].includes(to)
/** Statuses in which the evaluator may price a stay with the deal (the deal's own window still decides). */
export const PRICING_STATUSES: readonly DealStatus[] = ['ACTIVE', 'SCHEDULED']
export const TERMS_EDITABLE: readonly DealStatus[] = ['DRAFT']

/**
 * The state a reader should see today in the hotel's calendar, whatever the stored label says. A job that missed a night changes nothing about what
 * sells: the evaluator applies the same window (ADR 0089). `today` is the hotel-local day, or null when unknown (then the stored status stands).
 */
export function effectiveDealStatus(deal: { status: DealStatus; activeFrom: string | null; activeTo: string | null }, today: string | null): DealStatus {
  if (today === null) return deal.status
  if (deal.status === 'ACTIVE' || deal.status === 'SCHEDULED' || deal.status === 'PAUSED') {
    if (deal.activeTo !== null && today > deal.activeTo) return 'EXPIRED'
    if (deal.status === 'SCHEDULED' && (deal.activeFrom === null || today >= deal.activeFrom)) return 'ACTIVE'
    if (deal.status === 'ACTIVE' && deal.activeFrom !== null && today < deal.activeFrom) return 'SCHEDULED'
  }
  return deal.status
}

// ---- Fingerprint -------------------------------------------------------------------------------------------------------------------

/** Stable JSON of the terms a reviewer saw: sorted keys, bigint as decimal text, lists sorted. Two equal term sets always give the same text. */
export function canonicalDealTerms(hotelId: string, terms: DealTermsRow): string {
  const normalized: Record<string, unknown> = { hotelId }
  for (const key of Object.keys(terms).sort()) {
    const value = (terms as unknown as Record<string, unknown>)[key]
    normalized[key] = typeof value === 'bigint' ? value.toString() : Array.isArray(value) ? [...value].sort() : value === undefined ? null : value
  }
  return JSON.stringify(normalized, Object.keys(normalized).sort())
}
export const dealFingerprint = (hotelId: string, terms: DealTermsRow): string => createHash('sha256').update(canonicalDealTerms(hotelId, terms)).digest('hex')

// ---- Mapping to the evaluator --------------------------------------------------------------------------------------------------------

const ENGINE_KIND: Readonly<Record<DealKind, EngineKind>> = {
  PERCENT_OFF: 'PERCENT_OFF', EARLY_BIRD: 'EARLY_BIRD', FLASH_SALE: 'FLASH_SALE', STAY_X_PAY_Y: 'FREE_NIGHTS', SUBSEQUENT_NIGHTS: 'SUBSEQUENT_NIGHTS', EVERY_NTH_FREE: 'EVERY_NTH_FREE', FIXED_OFF: 'FIXED_OFF',
}

/** The one place a deal becomes a `PromotionRule`. `id` is the deal id, so the offer, the trace and the audit all name the same thing. */
export function dealToRule(id: string, terms: DealTermsRow): PromotionRule {
  const deal: DealTerms = {
    amountMinor: terms.amountMinor, currency: terms.currency, amountScope: terms.amountScope, fromNight: terms.fromNight, weekdays: terms.weekdays, activeFrom: terms.activeFrom, activeTo: terms.activeTo,
    priority: terms.priority, stackingGroup: terms.stackingGroup, incompatibleWith: terms.incompatibleDealIds, channels: terms.channels, sourceMarkets: terms.sourceMarkets, agencyIds: terms.agencyIds,
    maxDiscountBp: terms.maxDiscountBp, minSellFloorMinor: terms.minSellFloorMinor, minMarginBp: terms.minMarginBp,
  }
  return {
    id, kind: ENGINE_KIND[terms.kind], name: terms.name, percentBp: terms.percentBp, minLeadDays: terms.minLeadDays, maxLeadDays: null, minNights: terms.minNights, freeNights: terms.freeNights,
    bookFrom: terms.bookFrom, bookTo: terms.bookTo, stayFrom: terms.stayFrom, stayTo: terms.stayTo, combinable: terms.combinable, stayWindowMode: terms.stayWindowMode, discountBase: terms.discountBase, deal,
  }
}

/** A stored row (Prisma shape) to the terms. Dates become YYYY-MM-DD, so nothing downstream sees a Date or a time zone. */
export interface DealRow {
  code: string; name: string; kind: string; priority: number; percentBp: number | null; amountMinor: bigint | null; currency: string | null; amountScope: string | null
  minNights: number | null; freeNights: number | null; fromNight: number | null; minLeadDays: number | null
  bookFrom: Date | null; bookTo: Date | null; stayFrom: Date | null; stayTo: Date | null; weekdays: number | null
  stayWindowMode: string; discountBase: string; combinable: boolean; stackingGroup: string | null; incompatibleDealIds: string[]; channels: string[]; sourceMarkets: string[]; agencyIds: string[]
  maxDiscountBp: number | null; minSellFloorMinor: bigint | null; minMarginBp: number | null; activeFrom: Date | null; activeTo: Date | null; publicDescription: string | null; internalNotes: string | null
}
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
export function rowToTerms(row: DealRow, ratePlanIds: readonly string[]): DealTermsRow {
  return {
    code: row.code, name: row.name, kind: row.kind as DealKind, priority: row.priority, percentBp: row.percentBp, amountMinor: row.amountMinor, currency: row.currency, amountScope: row.amountScope as DealTermsRow['amountScope'],
    minNights: row.minNights, freeNights: row.freeNights, fromNight: row.fromNight, minLeadDays: row.minLeadDays, bookFrom: day(row.bookFrom), bookTo: day(row.bookTo), stayFrom: day(row.stayFrom), stayTo: day(row.stayTo),
    weekdays: row.weekdays, stayWindowMode: row.stayWindowMode as StayWindowMode, discountBase: row.discountBase as DiscountBase, combinable: row.combinable, stackingGroup: row.stackingGroup,
    incompatibleDealIds: [...row.incompatibleDealIds].sort(), channels: [...row.channels].sort(), sourceMarkets: [...row.sourceMarkets].sort(), agencyIds: [...row.agencyIds].sort(),
    maxDiscountBp: row.maxDiscountBp, minSellFloorMinor: row.minSellFloorMinor, minMarginBp: row.minMarginBp, activeFrom: day(row.activeFrom), activeTo: day(row.activeTo),
    publicDescription: row.publicDescription, internalNotes: row.internalNotes, ratePlanIds: [...ratePlanIds].sort(),
  }
}

const date = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00Z`) : null)
/** The Prisma column values of the terms (not the scope, which is its own table). */
export function termsToColumns(terms: DealTermsRow) {
  return {
    code: terms.code, codeKey: terms.code.toLowerCase(), name: terms.name, kind: terms.kind, priority: terms.priority, percentBp: terms.percentBp, amountMinor: terms.amountMinor, currency: terms.currency,
    amountScope: terms.amountScope, minNights: terms.minNights, freeNights: terms.freeNights, fromNight: terms.fromNight, minLeadDays: terms.minLeadDays, bookFrom: date(terms.bookFrom), bookTo: date(terms.bookTo),
    stayFrom: date(terms.stayFrom), stayTo: date(terms.stayTo), weekdays: terms.weekdays, stayWindowMode: terms.stayWindowMode, discountBase: terms.discountBase, combinable: terms.combinable,
    stackingGroup: terms.stackingGroup, incompatibleDealIds: terms.incompatibleDealIds, channels: terms.channels, sourceMarkets: terms.sourceMarkets, agencyIds: terms.agencyIds, maxDiscountBp: terms.maxDiscountBp,
    minSellFloorMinor: terms.minSellFloorMinor, minMarginBp: terms.minMarginBp, activeFrom: date(terms.activeFrom), activeTo: date(terms.activeTo), publicDescription: terms.publicDescription, internalNotes: terms.internalNotes,
  }
}
