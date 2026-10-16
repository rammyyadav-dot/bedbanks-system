import { SPECIAL_REQUEST_CODES, SPECIAL_REQUEST_LABELS, type SpecialRequestCode } from '@bedbanks/contracts'

export interface StoredSpecialRequests { codes: SpecialRequestCode[]; note?: string }

/** Reads `Booking.special_requests` (ADR 0066). Anything unexpected reads as no requests rather than as invented ones. */
export function readSpecialRequests(value: unknown): StoredSpecialRequests | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as { codes?: unknown; note?: unknown }
  const codes = Array.isArray(row.codes) ? SPECIAL_REQUEST_CODES.filter((code) => (row.codes as unknown[]).includes(code)) : []
  const note = typeof row.note === 'string' && row.note.trim() ? row.note.trim().slice(0, 300) : undefined
  return codes.length || note ? { codes, ...(note ? { note } : {}) } : null
}

export function specialRequestLabels(requests: StoredSpecialRequests | null): string[] {
  return requests ? requests.codes.map((code) => SPECIAL_REQUEST_LABELS[code]) : []
}
