import type { QuickUpdateChanges } from '@bedbanks/contracts'

/** How the Quick Update price panel changes prices (ADR 0067, F-14). The API validates and computes every night; this only builds the request. */
export type PriceMode = 'SET' | 'SEASONS' | 'PERCENT' | 'AMOUNT'
export interface SeasonRow { from: string; to: string; amount: string }

/** "+5", "-3.5", "12.25" -> signed basis points by string arithmetic (no floats). Null when not a percent with at most two decimals. */
export function signedPercentToBp(text: string): number | null {
  const m = /^([+-]?)(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text.trim())
  if (!m) return null
  const bp = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  return m[1] === '-' ? -bp : bp
}

/** The price change to send, or null when the panel would change nothing. Blank inputs are no change, never zero. */
export function priceChange(mode: PriceMode, input: { amount: string; basis: 'NET' | 'SELL'; adjust: string; seasons: SeasonRow[]; occupancy?: number }): QuickUpdateChanges['price'] | null {
  const occupancy = input.occupancy !== undefined ? { occupancy: input.occupancy } : {}
  if (mode === 'SET') return input.amount.trim() ? { amount: input.amount.trim(), basis: input.basis, ...occupancy } : null
  if (mode === 'SEASONS') { const seasons = input.seasons.filter((s) => s.from || s.to || s.amount.trim()); return seasons.length ? { seasons: seasons.map((s) => ({ ...s, amount: s.amount.trim() })), basis: input.basis, ...occupancy } : null }
  if (!input.adjust.trim()) return null
  if (mode === 'PERCENT') { const bp = signedPercentToBp(input.adjust); return bp === null ? { adjustPercentBp: Number.NaN, ...occupancy } : { adjustPercentBp: bp, ...occupancy } }
  return { adjustAmount: input.adjust.trim(), ...occupancy }
}
