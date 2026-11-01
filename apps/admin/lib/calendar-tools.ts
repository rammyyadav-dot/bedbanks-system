import type { CalendarEdit } from '@bedbanks/contracts'
import { parseMajorToMinor } from './minor-units'

/** Pure helpers for the multi-plan price grid and the CSV import (ADR 0057, S7). The API validates and decides; these only shape input and output. */

/** Spreadsheet paste (tab-separated, any newline style) into rows of trimmed cells. A trailing newline does not add a phantom row. */
export function parsePaste(text: string): string[][] {
  const rows = text.replace(/\r\n?/g, '\n').split('\n')
  if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
  return rows.map((row) => row.split('\t').map((cell) => cell.trim()))
}

export interface GridPlan { id: string; code: string; currency: string; occupancy: number }
export interface GridBaseline { amount: string; updatedAt: string | null }
export interface GridDraft {
  plans: readonly GridPlan[]
  dates: readonly string[]
  /** What the server returned, by plan then date. A missing entry is a cell that does not exist yet. */
  baseline: Readonly<Record<string, Readonly<Record<string, GridBaseline>>>>
  /** What the operator typed, by plan then date. Absent = untouched. */
  edited: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** NET or SELL per plan. Never assumed: empty blocks the plan's cells. */
  basis: Readonly<Record<string, 'NET' | 'SELL' | ''>>
}
export interface GridProblem { planId: string; date: string | null; message: string }
export const MAX_GRID_CELLS = 366

const sameAmount = (a: string, b: string) => a.trim() === b.trim()

/**
 * The calendar edit for every cell the operator changed, or the reasons it cannot be built. Nothing is guessed: a plan without a chosen basis,
 * an amount that is not a plain decimal in the plan currency, and a cleared price (prices are not deleted here) are reported, never repaired.
 */
export function buildGridEdit(draft: GridDraft): { edit: CalendarEdit | null; problems: GridProblem[]; changed: number } {
  const rates: NonNullable<CalendarEdit['rates']> = []
  const problems: GridProblem[] = []
  for (const plan of draft.plans) {
    const row = draft.edited[plan.id] ?? {}
    for (const date of draft.dates) {
      if (!(date in row)) continue
      const typed = row[date]!.trim()
      const base = draft.baseline[plan.id]?.[date]
      if (typed === '' && !base) continue // an empty cell that stays empty
      if (base && sameAmount(typed, base.amount)) continue
      if (typed === '') { problems.push({ planId: plan.id, date, message: 'A price cannot be cleared here. Set a stop sell to close the night instead.' }); continue }
      const basis = draft.basis[plan.id]
      if (basis !== 'NET' && basis !== 'SELL') { problems.push({ planId: plan.id, date: null, message: 'Choose NET or SELL for this plan before changing its prices.' }); continue }
      const minor = parseMajorToMinor(typed, plan.currency)
      if (minor === null || BigInt(minor) <= 0n) { problems.push({ planId: plan.id, date, message: `"${typed.slice(0, 20)}" is not a valid ${plan.currency} price (plain digits, optional decimal point, more than zero).` }); continue }
      rates.push({ ratePlanId: plan.id, stayDate: date, occupancy: plan.occupancy, amountMinor: minor, amountBasis: basis, currency: plan.currency, expectedUpdatedAt: base?.updatedAt ?? null })
    }
  }
  const unique = new Map(problems.map((p) => [`${p.planId}|${p.date}|${p.message}`, p]))
  if (rates.length > MAX_GRID_CELLS) return { edit: null, problems: [...unique.values(), { planId: '', date: null, message: `That is ${rates.length} changed cells; one review covers at most ${MAX_GRID_CELLS}. Apply some, then continue.` }], changed: rates.length }
  return { edit: rates.length ? { rates } : null, problems: [...unique.values()], changed: rates.length }
}

/** Fills pasted values right and down from (planIndex, dateIndex), clipped to the grid. Returns the new edited map; existing typed values elsewhere are kept. */
export function applyPaste(draft: Pick<GridDraft, 'plans' | 'dates' | 'edited'>, planIndex: number, dateIndex: number, matrix: string[][]): Record<string, Record<string, string>> {
  const next: Record<string, Record<string, string>> = Object.fromEntries(Object.entries(draft.edited).map(([k, v]) => [k, { ...v }]))
  matrix.forEach((cells, dy) => {
    const plan = draft.plans[planIndex + dy]
    if (!plan) return
    cells.forEach((value, dx) => {
      const date = draft.dates[dateIndex + dx]
      if (date === undefined) return
      ;(next[plan.id] ??= {})[date] = value
    })
  })
  return next
}

/** The error file for a rejected import: one row per issue, escaped so a spreadsheet never evaluates a cell that starts with = + - or @. */
export function issuesToCsv(issues: ReadonlyArray<{ line: number; code: string; message: string; field?: string }>): string {
  const cell = (v: string) => { const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe }
  return ['line,code,field,message', ...issues.map((i) => [String(i.line), i.code, i.field ?? '', i.message].map(cell).join(','))].join('\r\n') + '\r\n'
}

export const IMPORT_TEMPLATE = 'plan_code,date,amount,basis,allotment,stop_sell,min_stay\r\nBB-DBL,2026-12-01,450.00,SELL,5,false,1\r\n'
