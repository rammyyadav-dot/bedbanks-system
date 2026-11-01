import { SUPPLEMENT_BASIS_LABELS, SUPPLEMENT_FREQUENCY_LABELS, type ContractSupplementTerm } from '@bedbanks/contracts'
import { parseMajorToMinor } from './minor-units'

/** Board and compulsory supplements in Admin (ADR 0067). Display and form parsing only; the API validates and prices. */
export interface SupplementForm { kind: 'BOARD' | 'COMPULSORY'; name: string; boardBasisId: string; basis: ContractSupplementTerm['basis']; frequency: ContractSupplementTerm['frequency']; amount: string; stayFrom: string; stayTo: string }
export const blankSupplement: SupplementForm = { kind: 'COMPULSORY', name: '', boardBasisId: '', basis: 'PER_PERSON', frequency: 'PER_STAY', amount: '', stayFrom: '', stayTo: '' }

/** "Gala dinner: AED 250.00 per person, once per stay, 2026-12-31 to 2026-12-31". */
export function describeSupplement(s: Pick<ContractSupplementTerm, 'name' | 'basis' | 'frequency' | 'amountMinor' | 'currency' | 'stayFrom' | 'stayTo'>, money: (minor: string, currency: string) => string, boardName?: string): string {
  const window = s.stayFrom || s.stayTo ? `, stays ${s.stayFrom?.slice(0, 10) ?? 'any'} to ${s.stayTo?.slice(0, 10) ?? 'any'}` : ''
  return `${s.name}${boardName ? ` (${boardName})` : ''}: ${money(s.amountMinor, s.currency)} ${SUPPLEMENT_BASIS_LABELS[s.basis]}, ${SUPPLEMENT_FREQUENCY_LABELS[s.frequency]}${window}`
}

/** The term to send, or the first problem. Amounts are parsed into minor units in the contract currency, never through floating point. */
export function supplementFromForm(form: SupplementForm, currency: string): ContractSupplementTerm | string {
  if (!form.name.trim()) return 'Name the supplement as the contract does.'
  if (form.kind === 'BOARD' && !form.boardBasisId) return 'Choose the board this supplement prices.'
  const amount = parseMajorToMinor(form.amount, currency)
  if (amount === null || amount === '0') return `Enter the amount in ${currency}, greater than zero.`
  if (form.stayFrom && form.stayTo && form.stayTo < form.stayFrom) return 'The last stay night must be on or after the first.'
  return { kind: form.kind, name: form.name.trim(), boardBasisId: form.kind === 'BOARD' ? form.boardBasisId : null, ratePlanId: null, basis: form.basis, frequency: form.frequency, amountMinor: amount, currency, stayFrom: form.stayFrom || null, stayTo: form.stayTo || null }
}
