import { createHash } from 'node:crypto'
import type { ExtranetChangeCell, ExtranetImportIssue } from '@bedbanks/contracts'
import { buildCalendarImport, parseCsv, scanReferences, type ExistingAvailability, type ImportPlan } from '../supply/calendar-import'

/**
 * Validation of a supplier's availability CSV (ADR 0061 Amendment 3, slice 4a).
 *
 * It reuses the staff calendar-import parser unchanged (`buildCalendarImport`), so the file format, row-level errors, contract-term, expired-plan,
 * committed-inventory and duplicate rules are the staff ones. On top of that, slice 4a refuses everything that is not availability: no rate columns,
 * and no plan that draws from a shared inventory pool. The caller passes ONLY the plans the supplier's organization may change; a plan outside that
 * set is reported as not found, never as forbidden. The authoritative checks run again when staff apply the set.
 */
export interface SupplierCsvReport {
  ok: boolean
  fatal: ExtranetImportIssue[]
  errors: ExtranetImportIssue[]
  warnings: ExtranetImportIssue[]
  truncatedErrors: boolean
  cells: Array<ExtranetChangeCell & { expectedUpdatedAt: string | null }>
}

const RATE_COLUMNS = ['amount', 'basis', 'currency']

const refuse = (fatal: ExtranetImportIssue[], errors: ExtranetImportIssue[] = []): SupplierCsvReport => ({ ok: false, fatal, errors, warnings: [], truncatedErrors: false, cells: [] })

export function validateSupplierCsv(csv: unknown, plans: readonly ImportPlan[], availability: ReadonlyMap<string, ExistingAvailability>): SupplierCsvReport {
  if (typeof csv !== 'string' || csv.trim() === '') return refuse([{ line: 1, code: 'FILE_EMPTY', message: 'The file is empty.' }])

  const parsed = parseCsv(csv)
  if (parsed.ok && parsed.rows.length > 0) {
    const header = parsed.rows[0]!.map((name) => name.trim().toLowerCase())
    const rateColumn = RATE_COLUMNS.find((name) => header.includes(name))
    if (rateColumn) return refuse([{ line: 1, code: 'RATES_NOT_ACCEPTED', message: `The "${rateColumn}" column is not accepted: rates cannot be submitted yet. Submit allotment, stop_sell, min_stay and release_days only.`, field: rateColumn }])
  }

  // A plan that shares stock with other plans is refused as a whole, before the parser runs, with a message that names it.
  const refs = scanReferences(csv)
  const pooled = plans.filter((plan) => plan.inventoryPoolId !== null && (refs.planKeys.includes(plan.id) || refs.planKeys.includes(plan.code)))
  if (pooled.length > 0) {
    return refuse([], pooled.map((plan) => ({ line: 1, code: 'POOLED_PLAN', message: `Plan ${plan.code} draws from a shared inventory pool and cannot be changed here yet. Contact fBeds to change shared stock.` })))
  }

  const plansByCode = new Map<string, ImportPlan[]>()
  for (const plan of plans) plansByCode.set(plan.code, [...(plansByCode.get(plan.code) ?? []), plan])
  const built = buildCalendarImport(csv, {
    plansByCode,
    plansById: new Map(plans.map((plan) => [plan.id, plan])),
    rate: () => null,
    availability: (planId, date) => availability.get(`${planId}|${date}`) ?? null,
  })

  const errors: ExtranetImportIssue[] = built.errors.map(({ line, code, message, field }) => ({ line, code, message, ...(field ? { field } : {}) }))
  if (built.rates.length > 0) errors.push({ line: 1, code: 'RATES_NOT_ACCEPTED', message: 'Rates cannot be submitted yet.' })
  if (built.fatal.length === 0 && built.availability.length === 0 && errors.length === 0) errors.push({ line: 1, code: 'NOTHING_TO_CHANGE', message: 'The file contains no availability changes.' })

  const codeById = new Map(plans.map((plan) => [plan.id, plan.code]))
  const ok = built.fatal.length === 0 && errors.length === 0 && !built.truncatedErrors
  return {
    ok,
    fatal: built.fatal.map(({ line, code, message, field }) => ({ line, code, message, ...(field ? { field } : {}) })),
    errors,
    warnings: built.warnings.map(({ line, code, message }) => ({ line, code, message })),
    truncatedErrors: built.truncatedErrors,
    cells: ok
      ? built.availability.map((cell) => ({
        ratePlanId: cell.ratePlanId, ratePlanCode: codeById.get(cell.ratePlanId) ?? '', stayDate: cell.stayDate, allotment: cell.allotment,
        stopSell: cell.stopSell, minStay: cell.minStay, releaseDays: cell.releaseDays, expectedUpdatedAt: cell.expectedUpdatedAt,
      }))
      : [],
  }
}

/** SHA-256 over the canonical cells, so a reviewer can tell the set is the one that was submitted. Order-independent. */
export function cellsSha256(cells: ReadonlyArray<Pick<ExtranetChangeCell, 'ratePlanId' | 'stayDate' | 'allotment' | 'stopSell' | 'minStay' | 'releaseDays'>>): string {
  const canonical = [...cells]
    .sort((a, b) => (a.ratePlanId === b.ratePlanId ? (a.stayDate < b.stayDate ? -1 : a.stayDate > b.stayDate ? 1 : 0) : a.ratePlanId < b.ratePlanId ? -1 : 1))
    .map((c) => [c.ratePlanId, c.stayDate, c.allotment, c.stopSell, c.minStay, c.releaseDays])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
