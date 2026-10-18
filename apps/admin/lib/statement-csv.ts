import { STATEMENT_LINE_KINDS, STATEMENT_MAX_LINES, type StatementLineKindName, type StatementLineRequest } from '@bedbanks/contracts'

export interface CsvParseResult { lines: StatementLineRequest[]; errors: string[] }

const HEADERS = ['reference', 'kind', 'currency', 'amount'] as const
const AMOUNT = /^\d+(?:\.\d+)?$/

/** One CSV record: commas, semicolons or tabs; double quotes may wrap a field and "" is a literal quote. */
function fields(row: string, delimiter: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') { current += '"'; i += 1 } else if (ch === '"') quoted = false
      else current += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) { out.push(current.trim()); current = '' } else current += ch
  }
  out.push(current.trim())
  return out
}

/**
 * Turns pasted statement text into import lines. Amounts stay as the text the supplier wrote and are never converted here: the server converts them with the
 * currency exponent and is the authority. This only catches shape mistakes early, row by row, so an operator can fix the paste before sending.
 * Expected columns (header row required): reference, kind, currency, amount.
 */
export function parseStatementCsv(text: string): CsvParseResult {
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
  if (rows.length === 0) return { lines: [], errors: [] }
  const delimiter = [',', ';', '\t'].reduce((best, d) => (rows[0].split(d).length > rows[0].split(best).length ? d : best), ',')
  const header = fields(rows[0], delimiter).map((h) => h.toLowerCase())
  const index = HEADERS.map((h) => header.indexOf(h))
  if (index.some((i) => i < 0)) return { lines: [], errors: [`The first row must name the columns: ${HEADERS.join(', ')}`] }
  const lines: StatementLineRequest[] = []
  const errors: string[] = []
  rows.slice(1).forEach((row, n) => {
    const at = `Row ${n + 2}`
    const cells = fields(row, delimiter)
    if (cells.length > header.length) { errors.push(`${at}: has ${cells.length} columns but the header has ${header.length}; amounts must use a dot as the decimal separator`); return }
    const [reference, kindRaw, currencyRaw, amount] = index.map((i) => cells[i] ?? '')
    const kind = kindRaw.toUpperCase()
    const currency = currencyRaw.toUpperCase()
    if (!reference) errors.push(`${at}: reference is empty`)
    else if (!(STATEMENT_LINE_KINDS as readonly string[]).includes(kind)) errors.push(`${at}: kind must be ${STATEMENT_LINE_KINDS.join(', ')}`)
    else if (!/^[A-Z]{3}$/.test(currency)) errors.push(`${at}: currency must be a three-letter code`)
    else if (!AMOUNT.test(amount)) errors.push(`${at}: amount must be a positive number such as 123.45`)
    else lines.push({ reference, kind: kind as StatementLineKindName, currency, amount })
  })
  if (lines.length > STATEMENT_MAX_LINES) errors.push(`A statement may have at most ${STATEMENT_MAX_LINES} lines`)
  return { lines, errors }
}
