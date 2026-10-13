import { majorUnitsToMinor } from '@bedbanks/money'

/**
 * Rate and availability CSV import (ADR 0057, S7). Pure: no I/O, no clock.
 *
 * The file is parsed and validated row by row into the same cells the atomic calendar preview/apply takes, so an import never has a second
 * write path. Nothing is guessed: a basis (NET or SELL) is always explicit, an amount is a decimal in the plan currency's major units converted
 * with integer arithmetic, and a row that cannot be understood is reported with its line and reason instead of being repaired. Rows are accepted
 * or rejected individually; the caller applies exactly the accepted cells it previewed.
 */
/** Under the API's default 100 KB JSON body limit, which is left unchanged. One review covers at most 366 cells (about 15 KB), so this is generous. */
export const MAX_IMPORT_BYTES = 90_000
export const MAX_IMPORT_LINES = 2_000
export const MAX_IMPORT_CELLS = 366
export const MAX_REPORTED_ERRORS = 200

const COLUMNS = ['plan_code', 'plan_id', 'date', 'occupancy', 'amount', 'basis', 'currency', 'allotment', 'stop_sell', 'min_stay'] as const
type Column = (typeof COLUMNS)[number]

export interface ImportPlan {
  id: string; code: string; currency: string; occupancy: number; inventoryPoolId: string | null
  /** An EXPIRED plan is final (ADR 0041); its calendar is not edited. */
  expired?: boolean
  /** Contract term, YYYY-MM-DD. A cell outside it is never accepted. */
  contractValidFrom: string; contractValidTo: string
}
export interface ExistingRate { updatedAt: string }
export interface ExistingAvailability { updatedAt: string; allotment: number; sold: number; held: number; stopSell: boolean; minStay: number }
export interface ImportLookups {
  plansByCode: ReadonlyMap<string, ImportPlan[]>
  plansById: ReadonlyMap<string, ImportPlan>
  rate(planId: string, date: string, occupancy: number): ExistingRate | null
  availability(planId: string, date: string): ExistingAvailability | null
}
export interface ImportError { line: number; code: string; message: string; field?: Column }
export interface RateCell { ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string; expectedUpdatedAt: string | null }
export interface AvailabilityCell { ratePlanId: string; stayDate: string; allotment: number; stopSell: boolean; minStay: number; expectedUpdatedAt: string | null }
export interface ImportResult {
  ok: boolean
  /** File-level refusals (bad header, too large, too many cells). When set, no cell is produced. */
  fatal: ImportError[]
  errors: ImportError[]
  warnings: ImportError[]
  truncatedErrors: boolean
  rates: RateCell[]
  availability: AvailabilityCell[]
  stats: { lines: number; dataRows: number; acceptedRows: number; rejectedRows: number; identicalDuplicatesIgnored: number }
}

// ---- CSV (RFC 4180 subset): quotes, escaped quotes, CRLF/LF, one optional BOM. No evaluation of cell content (formula prefixes are just text). ------
export function parseCsv(text: string): { ok: true; rows: string[][]; lines: number[] } | { ok: false; line: number; message: string } {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []; const lines: number[] = []
  let row: string[] = []; let field = ''; let inQuotes = false; let line = 1; let fieldStarted = false; let rowLine = 1
  const endField = () => { row.push(field); field = ''; fieldStarted = false }
  const endRow = () => { endField(); if (!(row.length === 1 && row[0] === '')) { rows.push(row); lines.push(rowLine) } row = [] }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (inQuotes) {
      if (ch === '"') { if (source[i + 1] === '"') { field += '"'; i++ } else inQuotes = false } else { if (ch === '\n') line++; field += ch }
    } else if (ch === '"') {
      if (fieldStarted) return { ok: false, line, message: 'A quote may only start a field' }
      inQuotes = true; fieldStarted = true
    } else if (ch === ',') endField()
    else if (ch === '\r') { if (source[i + 1] === '\n') i++; line++; endRow(); rowLine = line }
    else if (ch === '\n') { line++; endRow(); rowLine = line }
    else { field += ch; fieldStarted = true }
  }
  if (inQuotes) return { ok: false, line, message: 'A quoted field is not closed' }
  if (field !== '' || row.length > 0) endRow()
  return { ok: true, rows, lines }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v: string) => DAY.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v
const INT = /^\d{1,9}$/
const parseBool = (v: string): boolean | null => { const x = v.trim().toLowerCase(); return ['true', '1', 'yes', 'y'].includes(x) ? true : ['false', '0', 'no', 'n'].includes(x) ? false : null }

interface ParsedRow {
  line: number; plan: ImportPlan; date: string; occupancy: number
  rate: { amountMinor: bigint; basis: 'NET' | 'SELL'; currency: string } | null
  allotment: number | null; stopSell: boolean | null; minStay: number | null
}

export function buildCalendarImport(csv: string, lookups: ImportLookups): ImportResult {
  const empty = (fatal: ImportError[], lines = 0): ImportResult => ({ ok: false, fatal, errors: [], warnings: [], truncatedErrors: false, rates: [], availability: [], stats: { lines, dataRows: 0, acceptedRows: 0, rejectedRows: 0, identicalDuplicatesIgnored: 0 } })
  if (typeof csv !== 'string' || csv.trim() === '') return empty([{ line: 1, code: 'FILE_EMPTY', message: 'The file is empty.' }])
  if (Buffer.byteLength(csv, 'utf8') > MAX_IMPORT_BYTES) return empty([{ line: 1, code: 'FILE_TOO_LARGE', message: `The file is larger than ${MAX_IMPORT_BYTES} bytes. Split it.` }])
  const parsed = parseCsv(csv)
  if (!parsed.ok) return empty([{ line: parsed.line, code: 'CSV_MALFORMED', message: parsed.message }])
  const [headerRow, ...dataRows] = parsed.rows
  const dataLines = parsed.lines.slice(1)
  if (!headerRow) return empty([{ line: 1, code: 'FILE_EMPTY', message: 'The file has no header row.' }])
  if (parsed.rows.length - 1 > MAX_IMPORT_LINES) return empty([{ line: 1, code: 'TOO_MANY_ROWS', message: `At most ${MAX_IMPORT_LINES} data rows per file.` }], parsed.rows.length)

  const header = headerRow.map((h) => h.trim().toLowerCase())
  const fatal: ImportError[] = []
  const seenColumns = new Set<string>()
  header.forEach((name) => {
    if (!(COLUMNS as readonly string[]).includes(name)) fatal.push({ line: 1, code: 'UNKNOWN_COLUMN', message: `Column "${name.slice(0, 40)}" is not recognised. Allowed: ${COLUMNS.join(', ')}.` })
    else if (seenColumns.has(name)) fatal.push({ line: 1, code: 'DUPLICATE_COLUMN', message: `Column "${name}" appears twice.` })
    seenColumns.add(name)
  })
  if (!seenColumns.has('date')) fatal.push({ line: 1, code: 'MISSING_COLUMN', message: 'A "date" column is required.', field: 'date' })
  if (!seenColumns.has('plan_code') && !seenColumns.has('plan_id')) fatal.push({ line: 1, code: 'MISSING_COLUMN', message: 'A "plan_code" or "plan_id" column is required.' })
  if (!['amount', 'allotment', 'stop_sell', 'min_stay'].some((c) => seenColumns.has(c))) fatal.push({ line: 1, code: 'MISSING_COLUMN', message: 'Nothing to change: add an "amount", "allotment", "stop_sell" or "min_stay" column.' })
  if (seenColumns.has('amount') && !seenColumns.has('basis')) fatal.push({ line: 1, code: 'MISSING_COLUMN', message: 'A "basis" column (NET or SELL) is required with "amount": the basis is never assumed.', field: 'basis' })
  if (fatal.length) return empty(fatal, parsed.rows.length)

  const col = (row: string[], name: Column): string => { const i = header.indexOf(name); return i < 0 ? '' : (row[i] ?? '').trim() }
  const errors: ImportError[] = []
  const warnings: ImportError[] = []
  const rejectedLines = new Set<number>()
  const fail = (line: number, code: string, message: string, field?: Column) => { errors.push({ line, code, message, ...(field ? { field } : {}) }); rejectedLines.add(line) }

  const rows: ParsedRow[] = []
  dataRows.forEach((row, index) => {
    const line = dataLines[index] ?? index + 2
    if (row.length > header.length) return fail(line, 'ROW_TOO_LONG', `The row has ${row.length} fields but the header has ${header.length}.`)
    const code = col(row, 'plan_code'); const idValue = col(row, 'plan_id')
    let plan: ImportPlan | undefined
    if (idValue) {
      plan = lookups.plansById.get(idValue)
      if (!plan) return fail(line, 'PLAN_NOT_FOUND', 'No rate plan with that id in this hotel.', 'plan_id')
      if (code && plan.code !== code) return fail(line, 'PLAN_MISMATCH', 'plan_code does not match plan_id.', 'plan_code')
    } else if (code) {
      const matches = lookups.plansByCode.get(code) ?? []
      if (matches.length === 0) return fail(line, 'PLAN_NOT_FOUND', `No rate plan with code "${code.slice(0, 40)}" in this hotel.`, 'plan_code')
      if (matches.length > 1) return fail(line, 'PLAN_AMBIGUOUS', `More than one plan has code "${code.slice(0, 40)}"; use plan_id.`, 'plan_code')
      plan = matches[0]
    } else return fail(line, 'PLAN_REQUIRED', 'plan_code or plan_id is required.', 'plan_code')
    if (plan!.expired) return fail(line, 'PLAN_EXPIRED', 'This plan has expired and is final; clone it to continue selling.', 'plan_code')
    const date = col(row, 'date')
    if (!isDay(date)) return fail(line, 'DATE_INVALID', 'Use a real calendar date, YYYY-MM-DD.', 'date')
    if (date < plan!.contractValidFrom || date > plan!.contractValidTo) return fail(line, 'DATE_OUTSIDE_CONTRACT', `${date} is outside the contract term ${plan!.contractValidFrom} to ${plan!.contractValidTo}.`, 'date')
    const occRaw = col(row, 'occupancy')
    const occupancy = occRaw === '' ? plan!.occupancy : INT.test(occRaw) ? Number(occRaw) : NaN
    if (!Number.isInteger(occupancy) || occupancy < 1) return fail(line, 'OCCUPANCY_INVALID', 'occupancy must be a whole number of 1 or more.', 'occupancy')
    if (occupancy !== plan!.occupancy) return fail(line, 'OCCUPANCY_MISMATCH', `This plan is for ${plan!.occupancy} guests, not ${occupancy}.`, 'occupancy')

    let rate: ParsedRow['rate'] = null
    const amountRaw = col(row, 'amount')
    if (amountRaw !== '') {
      const basis = col(row, 'basis').toUpperCase()
      if (basis !== 'NET' && basis !== 'SELL') return fail(line, 'BASIS_INVALID', 'basis must be NET or SELL.', 'basis')
      const currency = (col(row, 'currency') || plan!.currency).toUpperCase()
      if (currency !== plan!.currency) return fail(line, 'CURRENCY_MISMATCH', `This plan is priced in ${plan!.currency}, not ${currency}.`, 'currency')
      let minor: bigint
      try { minor = BigInt(majorUnitsToMinor(amountRaw, currency)) } catch (error) {
        return fail(line, 'AMOUNT_INVALID', `Amount "${amountRaw.slice(0, 20)}" is not a valid ${currency} amount${error instanceof Error && /scale/.test(error.message) ? ' (too many decimal places)' : ''}. Use plain digits with an optional decimal point, no thousands separators or symbols.`, 'amount')
      }
      if (minor <= 0n) return fail(line, 'AMOUNT_NOT_POSITIVE', 'A rate must be greater than zero (ADR 0034).', 'amount')
      rate = { amountMinor: minor, basis, currency }
    }
    const allotRaw = col(row, 'allotment')
    let allotment: number | null = null
    if (allotRaw !== '') { if (!INT.test(allotRaw)) return fail(line, 'ALLOTMENT_INVALID', 'allotment must be a whole number, zero or more.', 'allotment'); allotment = Number(allotRaw) }
    const stopRaw = col(row, 'stop_sell')
    let stopSell: boolean | null = null
    if (stopRaw !== '') { stopSell = parseBool(stopRaw); if (stopSell === null) return fail(line, 'STOP_SELL_INVALID', 'stop_sell must be true/false, yes/no or 1/0.', 'stop_sell') }
    const minRaw = col(row, 'min_stay')
    let minStay: number | null = null
    if (minRaw !== '') { if (!INT.test(minRaw) || Number(minRaw) < 1) return fail(line, 'MIN_STAY_INVALID', 'min_stay must be a whole number of 1 or more.', 'min_stay'); minStay = Number(minRaw) }
    if (!rate && allotment === null && stopSell === null && minStay === null) return fail(line, 'ROW_EMPTY', 'The row changes nothing: give an amount, allotment, stop_sell or min_stay.')

    // Availability rules that the apply step would also refuse, reported per row instead of failing the whole file.
    if (allotment !== null || stopSell !== null || minStay !== null) {
      const existing = lookups.availability(plan!.id, date)
      const effectiveAllotment = allotment ?? existing?.allotment ?? null
      if (effectiveAllotment === null) return fail(line, 'ALLOTMENT_REQUIRED', 'A new availability cell needs an allotment.', 'allotment')
      if (existing && effectiveAllotment < existing.sold + existing.held) return fail(line, 'ALLOTMENT_BELOW_COMMITTED', `Allotment ${effectiveAllotment} is below the ${existing.sold + existing.held} rooms already sold or held.`, 'allotment')
      if (plan!.inventoryPoolId && (!existing || effectiveAllotment !== existing.allotment)) return fail(line, 'POOLED_STOCK', 'This plan draws from a shared inventory pool: change stock in the pool capacity workflow. Restrictions (stop_sell, min_stay) are allowed.', 'allotment')
    }
    rows.push({ line, plan: plan!, date, occupancy, rate, allotment, stopSell, minStay })
  })

  // ---- duplicates: identical repeats collapse to one with a warning; conflicting repeats reject every occurrence -------------------------------
  const rateKey = (r: ParsedRow) => `${r.plan.id}|${r.date}|${r.occupancy}`
  const availKey = (r: ParsedRow) => `${r.plan.id}|${r.date}`
  const groups = new Map<string, ParsedRow[]>()
  for (const r of rows) for (const key of [r.rate ? `R|${rateKey(r)}` : null, (r.allotment !== null || r.stopSell !== null || r.minStay !== null) ? `A|${availKey(r)}` : null]) if (key) groups.set(key, [...(groups.get(key) ?? []), r])
  let identicalIgnored = 0
  for (const [key, group] of groups) {
    if (group.length < 2) continue
    const signature = (r: ParsedRow) => key.startsWith('R|') ? `${r.rate!.amountMinor}|${r.rate!.basis}|${r.rate!.currency}` : `${r.allotment}|${r.stopSell}|${r.minStay}`
    if (new Set(group.map(signature)).size === 1) {
      for (const dup of group.slice(1)) { warnings.push({ line: dup.line, code: 'DUPLICATE_IDENTICAL', message: 'Repeats an earlier row with identical values; ignored.' }); identicalIgnored += 1 }
    } else for (const r of group) fail(r.line, 'DUPLICATE_CONFLICT', `Line ${r.line} repeats ${key.startsWith('R|') ? 'the same rate cell' : 'the same availability cell'} with different values. Every occurrence is rejected; fix the file.`)
  }

  const accepted = rows.filter((r) => !rejectedLines.has(r.line))
  const rates: RateCell[] = []; const availability: AvailabilityCell[] = []
  const seenRate = new Set<string>(); const seenAvail = new Set<string>()
  for (const r of accepted) {
    if (r.rate && !seenRate.has(rateKey(r))) {
      seenRate.add(rateKey(r))
      rates.push({ ratePlanId: r.plan.id, stayDate: r.date, occupancy: r.occupancy, amountMinor: r.rate.amountMinor.toString(), amountBasis: r.rate.basis, currency: r.rate.currency, expectedUpdatedAt: lookups.rate(r.plan.id, r.date, r.occupancy)?.updatedAt ?? null })
    }
    if ((r.allotment !== null || r.stopSell !== null || r.minStay !== null) && !seenAvail.has(availKey(r))) {
      seenAvail.add(availKey(r))
      const existing = lookups.availability(r.plan.id, r.date)
      availability.push({ ratePlanId: r.plan.id, stayDate: r.date, allotment: (r.allotment ?? existing?.allotment)!, stopSell: r.stopSell ?? existing?.stopSell ?? false, minStay: r.minStay ?? existing?.minStay ?? 1, expectedUpdatedAt: existing?.updatedAt ?? null })
    }
  }
  const cells = rates.length + availability.length
  if (cells > MAX_IMPORT_CELLS) return { ...empty([{ line: 1, code: 'TOO_MANY_CELLS', message: `The file would change ${cells} cells; one review covers at most ${MAX_IMPORT_CELLS}. Split the file.` }], parsed.rows.length), stats: { lines: parsed.rows.length, dataRows: dataRows.length, acceptedRows: accepted.length, rejectedRows: rejectedLines.size, identicalDuplicatesIgnored: identicalIgnored } }
  errors.sort((a, b) => a.line - b.line)
  return {
    ok: errors.length === 0, fatal: [], errors: errors.slice(0, MAX_REPORTED_ERRORS), warnings: warnings.slice(0, MAX_REPORTED_ERRORS), truncatedErrors: errors.length > MAX_REPORTED_ERRORS,
    rates, availability,
    stats: { lines: parsed.rows.length, dataRows: dataRows.length, acceptedRows: accepted.length, rejectedRows: rejectedLines.size, identicalDuplicatesIgnored: identicalIgnored },
  }
}

/** The error file: one row per rejected line with the reason, for the operator to fix and re-upload. Cells starting with = + - @ are prefixed so a spreadsheet never evaluates them. */
export function errorsToCsv(errors: readonly ImportError[]): string {
  const cell = (v: string) => { const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe }
  return ['line,code,field,message', ...errors.map((e) => [String(e.line), e.code, e.field ?? '', e.message].map(cell).join(','))].join('\r\n') + '\r\n'
}

/** The plans and dates a file refers to, read cheaply so the caller loads only those cells' current versions. Anything it cannot read is ignored here and rejected by the real pass. */
export function scanReferences(csv: string): { planKeys: string[]; dates: string[] } {
  const parsed = typeof csv === 'string' && Buffer.byteLength(csv, 'utf8') <= MAX_IMPORT_BYTES ? parseCsv(csv) : null
  if (!parsed || !parsed.ok || parsed.rows.length < 2) return { planKeys: [], dates: [] }
  const header = parsed.rows[0]!.map((h) => h.trim().toLowerCase())
  const at = (name: string) => header.indexOf(name)
  const keys = new Set<string>(); const dates = new Set<string>()
  for (const row of parsed.rows.slice(1, MAX_IMPORT_LINES + 1)) {
    for (const name of ['plan_code', 'plan_id']) { const v = (row[at(name)] ?? '').trim(); if (v && at(name) >= 0) keys.add(v) }
    const d = (row[at('date')] ?? '').trim()
    if (at('date') >= 0 && isDay(d)) dates.add(d)
  }
  return { planKeys: [...keys], dates: [...dates] }
}
