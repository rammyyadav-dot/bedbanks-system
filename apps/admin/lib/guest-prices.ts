import type { RatePlanGuestPriceLine, RatePlanGuestPricesInput } from '@bedbanks/contracts'
import { minorToMajorInput, parseMajorToMinor } from './minor-units'

/** Child and extra-adult price lines as the plan page edits them (ADR 0057, S6). The API validates and is the authority; this only shapes input. */
export interface GuestLineDraft { kind: 'CHILD' | 'EXTRA_ADULT'; minAge: string; maxAge: string; amount: string; basis: 'NET' | 'SELL' | '' }

export const blankLine = (kind: GuestLineDraft['kind'] = 'CHILD'): GuestLineDraft => ({ kind, minAge: kind === 'CHILD' ? '0' : '', maxAge: kind === 'CHILD' ? '17' : '', amount: '', basis: '' })

export const draftFromLines = (lines: readonly RatePlanGuestPriceLine[]): GuestLineDraft[] =>
  lines.map((line) => ({ kind: line.kind, minAge: line.kind === 'CHILD' ? String(line.minAge) : '', maxAge: line.kind === 'CHILD' ? String(line.maxAge) : '', amount: minorToMajorInput(line.amountMinor, line.currency), basis: line.amountBasis }))

const AGE = /^\d{1,2}$/

export function buildGuestPricesInput(drafts: readonly GuestLineDraft[], currency: string, expectedUpdatedAt: string): { input: RatePlanGuestPricesInput | null; problems: string[] } {
  const problems: string[] = []
  const lines: RatePlanGuestPricesInput['lines'] = []
  drafts.forEach((draft, i) => {
    const at = `Line ${i + 1}`
    const minor = draft.amount.trim() === '' ? null : parseMajorToMinor(draft.amount, currency)
    if (minor === null) problems.push(`${at}: enter the price per night as a plain ${currency} amount (0 for a free guest).`)
    if (draft.basis !== 'NET' && draft.basis !== 'SELL') problems.push(`${at}: choose NET or SELL (the basis of the nightly rate it is added to).`)
    if (draft.kind === 'CHILD') {
      if (!AGE.test(draft.minAge) || !AGE.test(draft.maxAge) || Number(draft.maxAge) > 17 || Number(draft.maxAge) < Number(draft.minAge)) problems.push(`${at}: a child band needs whole ages from 0 to 17, with the maximum not below the minimum.`)
    }
    if (minor === null || (draft.basis !== 'NET' && draft.basis !== 'SELL')) return
    lines.push({ kind: draft.kind, ...(draft.kind === 'CHILD' ? { minAge: Number(draft.minAge), maxAge: Number(draft.maxAge) } : {}), amountMinor: minor, amountBasis: draft.basis, currency })
  })
  if (drafts.filter((d) => d.kind === 'EXTRA_ADULT').length > 1) problems.push('Only one extra-adult line per plan.')
  const bands = drafts.filter((d) => d.kind === 'CHILD' && AGE.test(d.minAge) && AGE.test(d.maxAge)).map((d) => [Number(d.minAge), Number(d.maxAge)] as const).sort((a, b) => a[0] - b[0])
  for (let i = 1; i < bands.length; i++) if (bands[i]![0] <= bands[i - 1]![1]) { problems.push(`Child bands ${bands[i - 1]![0]}-${bands[i - 1]![1]} and ${bands[i]![0]}-${bands[i]![1]} overlap; a child must match exactly one.`); break }
  return problems.length ? { input: null, problems } : { input: { expectedUpdatedAt, lines }, problems: [] }
}
