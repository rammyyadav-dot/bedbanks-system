import { HOTEL_DEAL_CHANNELS, type HotelDealChannel, type HotelDealCreateInput, type HotelDealKind, type HotelDealReplaceInput, type HotelDealTerms } from '@bedbanks/contracts'
import { minorToMajorInput, parseMajorToMinor } from './minor-units'
import { basisPointsToPercent, percentToBasisPoints } from './promotions'

/**
 * The deal form as an operator types it (ADR 0089). Percentages are plain percents sent as integer basis points, amounts are major units sent as minor-unit strings,
 * and no floating point is used. The API validates every field and is the authority; this only shapes input and catches the obvious mistakes early.
 */
export interface DealDraft {
  code: string; name: string; kind: HotelDealKind; priority: string
  percent: string; amount: string; currency: string; amountScope: 'PER_NIGHT' | 'PER_STAY'
  /** Nights of the stay (X) and nights paid (Y) for stay-X-pay-Y; `minNights` is also the Nth night of "every Nth free" and an optional minimum stay. */
  minNights: string; payNights: string; fromNight: string; minLeadDays: string
  bookFrom: string; bookTo: string; stayFrom: string; stayTo: string
  weekdays: number[]
  stayWindowMode: 'WHOLE_STAY' | 'NIGHTS_IN_WINDOW'; discountBase: 'ROOM_AND_GUESTS' | 'ROOM_ONLY'
  combinable: boolean; stackingGroup: string; incompatibleDealIds: string
  channels: HotelDealChannel[]; sourceMarkets: string; agencyIds: string[]
  maxDiscountPercent: string; minSellFloor: string; minMarginPercent: string
  activeFrom: string; activeTo: string
  publicDescription: string; internalNotes: string
  ratePlanIds: string[]
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
export const DEAL_CHANNEL_LABELS: Record<HotelDealChannel, string> = { PORTAL: 'Agent portal', API: 'Distribution API (not available yet)' }

export const blankDraft = (currency = 'AED'): DealDraft => ({
  code: '', name: '', kind: 'PERCENT_OFF', priority: '0', percent: '', amount: '', currency, amountScope: 'PER_NIGHT', minNights: '', payNights: '', fromNight: '2', minLeadDays: '',
  bookFrom: '', bookTo: '', stayFrom: '', stayTo: '', weekdays: [], stayWindowMode: 'WHOLE_STAY', discountBase: 'ROOM_AND_GUESTS', combinable: false, stackingGroup: '', incompatibleDealIds: '',
  channels: [], sourceMarkets: '', agencyIds: [], maxDiscountPercent: '', minSellFloor: '', minMarginPercent: '', activeFrom: '', activeTo: '', publicDescription: '', internalNotes: '', ratePlanIds: [],
})

const text = (value: number | null) => (value === null ? '' : String(value))

export function draftFromTerms(terms: HotelDealTerms): DealDraft {
  const currency = terms.currency ?? 'AED'
  return {
    code: terms.code, name: terms.name, kind: terms.kind, priority: String(terms.priority), percent: terms.percentBp === null ? '' : basisPointsToPercent(terms.percentBp),
    amount: terms.amountMinor === null ? '' : minorToMajorInput(terms.amountMinor, currency), currency, amountScope: terms.amountScope ?? 'PER_NIGHT',
    minNights: text(terms.minNights), payNights: terms.minNights !== null && terms.freeNights !== null ? String(terms.minNights - terms.freeNights) : '', fromNight: terms.fromNight === null ? '2' : String(terms.fromNight), minLeadDays: text(terms.minLeadDays),
    bookFrom: terms.bookFrom ?? '', bookTo: terms.bookTo ?? '', stayFrom: terms.stayFrom ?? '', stayTo: terms.stayTo ?? '', weekdays: [...terms.weekdays], stayWindowMode: terms.stayWindowMode, discountBase: terms.discountBase,
    combinable: terms.combinable, stackingGroup: terms.stackingGroup ?? '', incompatibleDealIds: terms.incompatibleDealIds.join(', '), channels: [...terms.channels], sourceMarkets: terms.sourceMarkets.join(', '), agencyIds: [...terms.agencyIds],
    maxDiscountPercent: terms.maxDiscountBp === null ? '' : basisPointsToPercent(terms.maxDiscountBp), minSellFloor: terms.minSellFloorMinor === null ? '' : minorToMajorInput(terms.minSellFloorMinor, currency),
    minMarginPercent: terms.minMarginBp === null ? '' : basisPointsToPercent(terms.minMarginBp), activeFrom: terms.activeFrom ?? '', activeTo: terms.activeTo ?? '',
    publicDescription: terms.publicDescription ?? '', internalNotes: terms.internalNotes ?? '', ratePlanIds: [...terms.ratePlanIds],
  }
}

const whole = (value: string): number | null => (/^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : null)
const list = (value: string): string[] => value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)

/** Which parameter fields each kind shows (and therefore sends). */
export const KIND_FIELDS: Record<HotelDealKind, ReadonlyArray<'percent' | 'amount' | 'minNights' | 'stayXPayY' | 'nth' | 'fromNight' | 'minLeadDays' | 'bookWindowRequired'>> = {
  PERCENT_OFF: ['percent', 'minNights'], EARLY_BIRD: ['percent', 'minLeadDays', 'minNights'], FLASH_SALE: ['percent', 'bookWindowRequired', 'minNights'], STAY_X_PAY_Y: ['stayXPayY'],
  SUBSEQUENT_NIGHTS: ['percent', 'fromNight', 'minNights'], EVERY_NTH_FREE: ['nth'], FIXED_OFF: ['amount', 'minNights'],
}

/** Everything the draft says, as the API's terms. Problems are returned together; when any exist nothing is built. */
export function buildTerms(draft: DealDraft): { terms: Omit<HotelDealTerms, 'ratePlanIds'> & { ratePlanIds: string[] } | null; problems: string[] } {
  const problems: string[] = []
  const fields = KIND_FIELDS[draft.kind]
  const has = (field: (typeof fields)[number]) => fields.includes(field)
  const priority = whole(draft.priority)
  if (priority === null || priority > 100) problems.push('Priority is a whole number from 0 to 100.')
  const percentBp = has('percent') ? percentToBasisPoints(draft.percent) : null
  if (has('percent') && (percentBp === null || percentBp < 1 || percentBp > 9000)) problems.push('The discount is a percentage from 0.01 to 90 with at most two decimals.')
  let amountMinor: string | null = null
  if (has('amount')) { amountMinor = parseMajorToMinor(draft.amount, draft.currency); if (amountMinor === null || amountMinor === '0') { problems.push(`The amount is a positive ${draft.currency} amount with at most two decimals.`); amountMinor = null } }
  let minNights: number | null = null; let freeNights: number | null = null
  if (has('minNights') && draft.minNights.trim()) { minNights = whole(draft.minNights); if (minNights === null || minNights < 1 || minNights > 365) problems.push('Minimum nights is a whole number from 1 to 365.') }
  if (has('stayXPayY')) {
    const stay = whole(draft.minNights); const pay = whole(draft.payNights)
    if (stay === null || pay === null || stay < 2 || pay < 1 || pay >= stay) problems.push('Stay X, pay Y needs X of at least 2 and Y of at least 1, below X.')
    else { minNights = stay; freeNights = stay - pay }
  }
  if (has('nth')) { minNights = whole(draft.minNights); if (minNights === null || minNights < 2 || minNights > 365) problems.push('Every Nth night needs N from 2 to 365.') }
  const fromNight = has('fromNight') ? whole(draft.fromNight) : null
  if (has('fromNight') && (fromNight === null || fromNight < 2 || fromNight > 365)) problems.push('The first discounted night is a whole number from 2 to 365.')
  const minLeadDays = has('minLeadDays') ? whole(draft.minLeadDays) : null
  if (has('minLeadDays') && (minLeadDays === null || minLeadDays < 1 || minLeadDays > 730)) problems.push('Book at least this many days ahead: a whole number from 1 to 730.')
  if (has('bookWindowRequired') && (!draft.bookFrom || !draft.bookTo)) problems.push('A flash sale needs both booking window dates.')
  const optionalPercent = (label: string, value: string, min: number, max: number): number | null => {
    if (!value.trim()) return null
    const bp = percentToBasisPoints(value)
    if (bp === null || bp < min || bp > max) { problems.push(`${label} is a percentage with at most two decimals.`); return null }
    return bp
  }
  const maxDiscountBp = optionalPercent('Maximum discount', draft.maxDiscountPercent, 1, 9000)
  const minMarginBp = optionalPercent('Minimum margin', draft.minMarginPercent, 1, 9000)
  let minSellFloorMinor: string | null = null
  if (draft.minSellFloor.trim()) { minSellFloorMinor = parseMajorToMinor(draft.minSellFloor, draft.currency); if (minSellFloorMinor === null || minSellFloorMinor === '0') { problems.push(`The minimum sell floor is a positive ${draft.currency} amount with at most two decimals.`); minSellFloorMinor = null } }
  if (percentBp !== null && percentBp > 5000 && minSellFloorMinor === null) problems.push('A discount above 50% needs a minimum sell floor.')
  const day = /^\d{4}-\d{2}-\d{2}$/
  for (const [label, value] of [['Booking window start', draft.bookFrom], ['Booking window end', draft.bookTo], ['Travel start', draft.stayFrom], ['Travel end', draft.stayTo], ['Active from', draft.activeFrom], ['Active to', draft.activeTo]] as const) if (value && !day.test(value)) problems.push(`${label} is not a date.`)
  if (draft.bookFrom && draft.bookTo && draft.bookTo < draft.bookFrom) problems.push('The booking window ends before it starts.')
  if (draft.stayFrom && draft.stayTo && draft.stayTo < draft.stayFrom) problems.push('The travel window ends before it starts.')
  if (draft.activeFrom && draft.activeTo && draft.activeTo < draft.activeFrom) problems.push('The deal ends before it starts.')
  if (draft.stayWindowMode === 'NIGHTS_IN_WINDOW' && !draft.stayFrom && !draft.stayTo) problems.push('Discounting only the nights inside the window needs a travel window.')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/.test(draft.code.trim())) problems.push('The code is 2 to 40 letters, digits, hyphens or underscores.')
  if (draft.name.trim().length < 1 || draft.name.trim().length > 80) problems.push('The name is 1 to 80 characters (agents see it).')
  const markets = list(draft.sourceMarkets).map((item) => item.toUpperCase())
  if (markets.some((market) => !/^[A-Z]{2}$/.test(market))) problems.push('Source markets are two-letter country codes, for example IN, AE, GB.')
  if (draft.ratePlanIds.length === 0) problems.push('Select at least one rate plan.')
  if (problems.length) return { terms: null, problems }
  return {
    problems,
    terms: {
      code: draft.code.trim(), name: draft.name.trim(), kind: draft.kind, priority: priority as number, percentBp, amountMinor, currency: draft.kind === 'FIXED_OFF' ? draft.currency : null, amountScope: draft.kind === 'FIXED_OFF' ? draft.amountScope : null,
      minNights, freeNights, fromNight, minLeadDays, bookFrom: draft.bookFrom || null, bookTo: draft.bookTo || null, stayFrom: draft.stayFrom || null, stayTo: draft.stayTo || null, weekdays: [...draft.weekdays].sort(),
      stayWindowMode: draft.stayWindowMode, discountBase: draft.discountBase, combinable: draft.combinable, stackingGroup: draft.stackingGroup.trim() || null, incompatibleDealIds: list(draft.incompatibleDealIds),
      channels: draft.channels.filter((channel) => (HOTEL_DEAL_CHANNELS as readonly string[]).includes(channel)), sourceMarkets: markets, agencyIds: [...draft.agencyIds], maxDiscountBp, minSellFloorMinor, minMarginBp,
      activeFrom: draft.activeFrom || null, activeTo: draft.activeTo || null, publicDescription: draft.publicDescription.trim() || null, internalNotes: draft.internalNotes.trim() || null, ratePlanIds: [...draft.ratePlanIds],
    },
  }
}

/** Optional fields that are empty are left out, so the API applies its own defaults. */
const compact = <T extends object>(terms: T): T => Object.fromEntries(Object.entries(terms).filter(([, value]) => value !== null)) as T

export function buildCreateInput(draft: DealDraft, hotelId: string, idempotencyKey: string): { input: HotelDealCreateInput | null; problems: string[] } {
  const { terms, problems } = buildTerms(draft)
  if (!terms) return { input: null, problems }
  return { input: { ...compact(terms), hotelId, idempotencyKey } as HotelDealCreateInput, problems }
}

export function buildReplaceInput(draft: DealDraft, expectedVersion: number): { input: HotelDealReplaceInput | null; problems: string[] } {
  const { terms, problems } = buildTerms(draft)
  if (!terms) return { input: null, problems }
  return { input: { ...compact(terms), expectedVersion } as HotelDealReplaceInput, problems }
}

/** The messages of an API failure's issue list: the API sends objects ({ code, field, message, severity }), older routes plain strings. */
export function issueMessages(error: { details?: readonly string[]; structuredDetails?: readonly unknown[] }): string[] {
  const fromObjects = (error.structuredDetails ?? []).flatMap((item) => (typeof item === 'object' && item !== null && typeof (item as { message?: unknown }).message === 'string' ? [(item as { message: string }).message] : []))
  return fromObjects.length ? fromObjects : [...(error.details ?? [])]
}

/** Display only: one line describing what a deal does. The API is the authority on what it prices. */
export function describeTerms(terms: Pick<HotelDealTerms, 'kind' | 'percentBp' | 'amountMinor' | 'currency' | 'amountScope' | 'minNights' | 'freeNights' | 'fromNight' | 'minLeadDays'>): string {
  const pct = terms.percentBp === null ? '' : `${basisPointsToPercent(terms.percentBp)}%`
  switch (terms.kind) {
    case 'PERCENT_OFF': return `${pct} off`
    case 'EARLY_BIRD': return `${pct} off when booked ${terms.minLeadDays}+ days ahead`
    case 'FLASH_SALE': return `${pct} off in a limited booking window`
    case 'STAY_X_PAY_Y': return `Stay ${terms.minNights}, pay ${(terms.minNights ?? 0) - (terms.freeNights ?? 0)}`
    case 'SUBSEQUENT_NIGHTS': return `${pct} off from night ${terms.fromNight}`
    case 'EVERY_NTH_FREE': return `Every ${terms.minNights}th night free`
    case 'FIXED_OFF': return `${terms.currency ?? ''} ${terms.amountMinor === null || terms.currency === null ? '' : minorToMajorInput(terms.amountMinor, terms.currency)} off ${terms.amountScope === 'PER_STAY' ? 'per stay' : 'per night'}`.trim()
  }
}
