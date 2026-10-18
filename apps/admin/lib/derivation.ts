import type { DerivedRateMode, RatePlanDerivationInput } from '@bedbanks/contracts'
import { formatMinorUnits, minorToMajorInput, parseMajorToMinor } from './minor-units'

/**
 * Derived rate plan terms as the plan page edits them (ADR 0058, S10b). A percentage is typed as a signed percent ("-10", "12.5") and sent as integer basis
 * points; a fixed amount is typed in major units ("-25.50") and sent as integer minor units. Nothing passes through floating point. The API validates the
 * rest and is the authority; this shapes input and catches the obvious mistakes early.
 */
export interface DerivationDraft { parentId: string; mode: DerivedRateMode; amount: string }

export const blankDerivation = (): DerivationDraft => ({ parentId: '', mode: 'PERCENT_BP', amount: '' })

const LIMITS = { PERCENT_BP: { min: -9000, max: 100_000 }, FIXED_MINOR: { min: -2_000_000_000, max: 2_000_000_000 } } as const

/** "-10" -> -1000, "12.5" -> 1250, "+5" -> 500; null when it is not a plain signed percent with at most two decimals. */
export function signedPercentToBasisPoints(text: string): number | null {
  const match = /^([+-]?)(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!match) return null
  const magnitude = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0') || '0')
  return match[1] === '-' ? -magnitude : magnitude
}

export function basisPointsToSignedPercent(bp: number): string {
  const negative = bp < 0; const magnitude = Math.abs(bp); const whole = Math.floor(magnitude / 100); const frac = magnitude % 100
  const body = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`
  return `${negative ? '-' : ''}${body}`
}

/** Fixed adjustment as the editor shows it: signed major units. */
export function minorToSignedMajor(minor: number, currency: string): string {
  return `${minor < 0 ? '-' : ''}${minorToMajorInput(String(Math.abs(minor)), currency)}`
}

/** Signed major units to integer minor units; null when not a plain signed decimal within the currency's precision or too large. */
export function signedMajorToMinor(text: string, currency: string): number | null {
  const t = text.trim(); const negative = t.startsWith('-'); const body = t.replace(/^[+-]/, '')
  const minor = parseMajorToMinor(body, currency)
  if (minor === null) return null
  const value = BigInt(minor)
  if (value > BigInt(LIMITS.FIXED_MINOR.max)) return null
  return negative ? -Number(value) : Number(value)
}

export function buildDerivationInput(draft: DerivationDraft, currency: string, expectedUpdatedAt: string): { input: RatePlanDerivationInput | null; problems: string[] } {
  const problems: string[] = []
  if (!draft.parentId) problems.push('Choose the plan this one is derived from.')
  const adjustment = draft.mode === 'PERCENT_BP' ? signedPercentToBasisPoints(draft.amount) : signedMajorToMinor(draft.amount, currency)
  if (adjustment === null) problems.push(draft.mode === 'PERCENT_BP' ? 'Enter the adjustment as a percent, for example -10 or 12.5 (at most two decimals).' : `Enter the adjustment as a ${currency} amount, for example -25 or 25.50.`)
  else if (adjustment < LIMITS[draft.mode].min || adjustment > LIMITS[draft.mode].max) problems.push(draft.mode === 'PERCENT_BP' ? 'A percentage adjustment is from -90% to +1000%.' : 'That adjustment is too large.')
  return problems.length || adjustment === null ? { input: null, problems } : { input: { expectedUpdatedAt, parentId: draft.parentId, mode: draft.mode, adjustment }, problems: [] }
}

/** One line for the plan list and the panel: "10% below PARENT" or "AED 25.00 above PARENT". */
export function describeDerivation(derived: { parentCode: string; mode: DerivedRateMode; adjustment: number }, currency: string): string {
  const same = derived.adjustment === 0
  const below = derived.adjustment < 0
  const amount = derived.mode === 'PERCENT_BP' ? `${basisPointsToSignedPercent(Math.abs(derived.adjustment))}%` : formatMinorUnits(String(Math.abs(derived.adjustment)), currency)
  return same ? `Same price as ${derived.parentCode}` : `${amount} ${below ? 'below' : 'above'} ${derived.parentCode}`
}
