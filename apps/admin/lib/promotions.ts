import type { PromotionKind, RatePlanPromotion, RatePlanPromotionsInput } from '@bedbanks/contracts'

/**
 * Promotions as the plan page edits them (ADR 0058, S10a). The percentage is typed as a plain percent ("12.5") and sent as integer basis points; no floating
 * point is used. The API validates every field and is the authority; this only shapes input and catches the obvious mistakes early.
 */
export interface PromotionDraft {
  kind: PromotionKind; name: string; percent: string; minLeadDays: string; maxLeadDays: string; minNights: string; freeNights: string
  bookFrom: string; bookTo: string; stayFrom: string; stayTo: string
}

export const KIND_LABELS: Record<PromotionKind, string> = { EARLY_BIRD: 'Early bird', LAST_MINUTE: 'Last minute', LONG_STAY: 'Long stay', FREE_NIGHTS: 'Free nights' }

export const blankPromotion = (kind: PromotionKind = 'EARLY_BIRD'): PromotionDraft => ({ kind, name: '', percent: '', minLeadDays: '', maxLeadDays: '', minNights: '', freeNights: '', bookFrom: '', bookTo: '', stayFrom: '', stayTo: '' })

/** "12.5" -> 1250 basis points; null when it is not a plain percent with at most two decimals. */
export function percentToBasisPoints(text: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0')
}
export const basisPointsToPercent = (bp: number): string => { const whole = Math.floor(bp / 100); const frac = bp % 100; return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}` }

export const draftFromPromotions = (rows: readonly RatePlanPromotion[]): PromotionDraft[] => rows.map((row) => ({
  kind: row.kind, name: row.name, percent: row.percentBp === null ? '' : basisPointsToPercent(row.percentBp),
  minLeadDays: row.minLeadDays === null ? '' : String(row.minLeadDays), maxLeadDays: row.maxLeadDays === null ? '' : String(row.maxLeadDays),
  minNights: row.minNights === null ? '' : String(row.minNights), freeNights: row.freeNights === null ? '' : String(row.freeNights),
  bookFrom: row.bookFrom ?? '', bookTo: row.bookTo ?? '', stayFrom: row.stayFrom ?? '', stayTo: row.stayTo ?? '',
}))

const whole = (text: string, min: number, max: number): number | null => (/^\d{1,4}$/.test(text.trim()) && Number(text) >= min && Number(text) <= max ? Number(text) : null)
const day = (text: string): string | null | undefined => { const t = text.trim(); if (t === '') return null; return /^\d{4}-\d{2}-\d{2}$/.test(t) && new Date(`${t}T00:00:00Z`).toISOString().slice(0, 10) === t ? t : undefined }

export function buildPromotionsInput(drafts: readonly PromotionDraft[], expectedUpdatedAt: string): { input: RatePlanPromotionsInput | null; problems: string[] } {
  const problems: string[] = []
  const promotions: RatePlanPromotion[] = []
  const names = new Set<string>()
  drafts.forEach((draft, i) => {
    const at = `Promotion ${i + 1}`
    const name = draft.name.trim()
    if (name.length < 1 || name.length > 80) problems.push(`${at}: give it a name of 1 to 80 characters (agents see it).`)
    else if (names.has(name.toLowerCase())) problems.push(`${at}: the name "${name}" is used twice.`)
    names.add(name.toLowerCase())
    const percentKind = draft.kind !== 'FREE_NIGHTS'
    const percentBp = percentKind ? percentToBasisPoints(draft.percent) : null
    if (percentKind && (percentBp === null || percentBp < 1 || percentBp > 9000)) problems.push(`${at}: enter a discount from 0.01 to 90 percent. A free night is a Free nights promotion.`)
    const minLeadDays = draft.kind === 'EARLY_BIRD' ? whole(draft.minLeadDays, 1, 730) : null
    const maxLeadDays = draft.kind === 'LAST_MINUTE' ? whole(draft.maxLeadDays, 0, 365) : null
    if (draft.kind === 'EARLY_BIRD' && minLeadDays === null) problems.push(`${at}: enter the days of notice required (1 to 730).`)
    if (draft.kind === 'LAST_MINUTE' && maxLeadDays === null) problems.push(`${at}: enter the most days of notice allowed (0 to 365).`)
    const nightsKind = draft.kind === 'LONG_STAY' || draft.kind === 'FREE_NIGHTS'
    const minNights = nightsKind ? whole(draft.minNights, 2, 365) : null
    if (nightsKind && minNights === null) problems.push(`${at}: enter the minimum nights (2 to 365).`)
    const freeNights = draft.kind === 'FREE_NIGHTS' ? whole(draft.freeNights, 1, 364) : null
    if (draft.kind === 'FREE_NIGHTS' && (freeNights === null || (minNights !== null && freeNights >= minNights))) problems.push(`${at}: free nights must be fewer than the minimum nights, so the stay keeps a paid night.`)
    const dates = { bookFrom: day(draft.bookFrom), bookTo: day(draft.bookTo), stayFrom: day(draft.stayFrom), stayTo: day(draft.stayTo) }
    for (const [key, value] of Object.entries(dates)) if (value === undefined) problems.push(`${at}: ${key} must be a real date (YYYY-MM-DD) or empty.`)
    if (dates.bookFrom && dates.bookTo && dates.bookTo < dates.bookFrom) problems.push(`${at}: the booking window ends before it starts.`)
    if (dates.stayFrom && dates.stayTo && dates.stayTo < dates.stayFrom) problems.push(`${at}: the stay window ends before it starts.`)
    promotions.push({ kind: draft.kind, name, percentBp, minLeadDays, maxLeadDays, minNights, freeNights, bookFrom: dates.bookFrom ?? null, bookTo: dates.bookTo ?? null, stayFrom: dates.stayFrom ?? null, stayTo: dates.stayTo ?? null })
  })
  return problems.length ? { input: null, problems } : { input: { expectedUpdatedAt, promotions }, problems: [] }
}
