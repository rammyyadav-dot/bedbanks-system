export interface CalendarEdit {
  rates?: Array<{ ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string; expectedUpdatedAt: string | null }>
  availability?: Array<{ ratePlanId: string; stayDate: string; allotment: number; stopSell: boolean; minStay: number; expectedUpdatedAt: string | null }>
}
export interface CalendarPreview {
  atomic: boolean; affectedCells: number;
  changes: Array<{ kind: string; ratePlanId: string; stayDate: string; before: Record<string, unknown> | null; after: Record<string, unknown> }>
}

/**
 * CSV import of rates and availability (ADR 0057, S7). `POST /supply/calendar/import/preview` validates the file row by row and returns the
 * cells it would change as an ordinary `CalendarEdit`, with each cell's current version, plus the standard preview. Nothing is written. Applying is
 * the existing `POST /supply/calendar/apply` with exactly that `edit`, so an import has no second write path and a stale review is refused per cell.
 * Rows are accepted or rejected individually; rejected rows are listed and are NOT applied.
 */
export interface CalendarImportRequest { hotelId: string; csv: string }
export interface CalendarImportIssue { line: number; code: string; message: string; field?: string }
export interface CalendarImportPreview {
  /** True only when the file has no fatal refusal and no rejected row. */
  ok: boolean
  fatal: CalendarImportIssue[]
  errors: CalendarImportIssue[]
  warnings: CalendarImportIssue[]
  truncatedErrors: boolean
  stats: { lines: number; dataRows: number; acceptedRows: number; rejectedRows: number; identicalDuplicatesIgnored: number }
  /** The accepted cells, ready for `calendar/apply`. Null when nothing was accepted. */
  edit: CalendarEdit | null
  preview: CalendarPreview | null
}

