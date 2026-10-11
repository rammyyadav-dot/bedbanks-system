import type { HotelCommercialRow } from '@bedbanks/contracts'

/** Hard ceiling on one download. A larger result is cut at the ceiling and the response says so; it is never silently complete. */
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

/** Directory fields only. No contacts, owner, free text, rates, guest data or supplier payloads are exported. */
export function hotelCsv(rows: readonly HotelCommercialRow[]): string {
  const lines = [HOTEL_EXPORT_COLUMNS.join(',')]
  for (const h of rows) {
    lines.push([h.id, h.name, h.code, h.countryCode, h.city, h.propertyType, h.starRating, h.contentStatus, h.hotelMapping, h.verifiedMappings, h.rooms.active, h.contractState, h.rates, h.inventory, h.readiness, h.issues.total, h.updatedAt].map(csvCell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}
