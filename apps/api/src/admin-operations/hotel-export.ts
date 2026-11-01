import type { HotelCommercialRow } from '@bedbanks/contracts'

/**
 * Streamed downloads (ADR 0074) are bounded by this instead: rows are produced in small keyset batches, so memory does not grow with it. The limit is set by
 * time, not memory: every row needs the commercial assessment (about 14 ms of CPU per hotel when measured on PostgreSQL 16 with 6 rate plans x 60 days per
 * hotel), so 25,000 rows is roughly six minutes. Above it the response says it is truncated (X-Export-Truncated). Raising it needs the assessment made cheaper first.
 */
export const HOTEL_EXPORT_STREAM_MAX_ROWS = 25_000
/** Rows per keyset batch. Small on purpose: the assessment of a batch is synchronous work on the API's event loop (about 0.7 s for 50 hotels). */
export const HOTEL_EXPORT_STREAM_BATCH = 50

/** Hard ceiling on one buffered download. A larger result is cut at the ceiling and the response says so; it is never silently complete. */
export const HOTEL_EXPORT_MAX_ROWS = 1000

export const HOTEL_EXPORT_COLUMNS = ['canonical_id', 'name', 'supplier_code', 'country', 'city', 'property_type', 'stars', 'profile_status', 'hotel_mapping', 'verified_mappings', 'active_rooms', 'contract_state', 'rates', 'inventory', 'readiness', 'issues', 'updated_at'] as const

/**
 * One CSV cell. Values that a spreadsheet would run as a formula (leading = + - @ tab or CR) are prefixed with an apostrophe,
 * and any cell holding a quote, comma or line break is quoted, so supplier-supplied hotel names cannot execute in the operator's spreadsheet.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const hotelCsvHeader = (): string => `${HOTEL_EXPORT_COLUMNS.join(',')}\r\n`

/** Data lines only (no header), each CRLF terminated, so a stream can emit them batch by batch. */
export function hotelCsvLines(rows: readonly HotelCommercialRow[]): string {
  let out = ''
  for (const h of rows) out += `${[h.id, h.name, h.code, h.countryCode, h.city, h.propertyType, h.starRating, h.contentStatus, h.hotelMapping, h.verifiedMappings, h.rooms.active, h.contractState, h.rates, h.inventory, h.readiness, h.issues.total, h.updatedAt].map(csvCell).join(',')}\r\n`
  return out
}

/** Directory fields only. No contacts, owner, free text, rates, guest data or supplier payloads are exported. */
export function hotelCsv(rows: readonly HotelCommercialRow[]): string {
  return hotelCsvHeader() + hotelCsvLines(rows)
}
