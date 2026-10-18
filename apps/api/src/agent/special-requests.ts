import { ARRIVAL_TIME_PATTERN, SPECIAL_REQUEST_CODES, SPECIAL_REQUEST_LABELS, type SpecialRequestCode } from '@bedbanks/contracts'

export interface StoredSpecialRequests { codes: SpecialRequestCode[]; note?: string; arrivalTime?: string }

/** Reads `Booking.special_requests` (ADR 0066). Anything unexpected reads as no requests rather than as invented ones. */
export function readSpecialRequests(value: unknown): StoredSpecialRequests | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as { codes?: unknown; note?: unknown; arrivalTime?: unknown }
  const codes = Array.isArray(row.codes) ? SPECIAL_REQUEST_CODES.filter((code) => (row.codes as unknown[]).includes(code)) : []
  const note = typeof row.note === 'string' && row.note.trim() ? row.note.trim().slice(0, 300) : undefined
  const arrivalTime = typeof row.arrivalTime === 'string' && ARRIVAL_TIME_PATTERN.test(row.arrivalTime) ? row.arrivalTime : undefined
  return codes.length || note || arrivalTime ? { codes, ...(note ? { note } : {}), ...(arrivalTime ? { arrivalTime } : {}) } : null
}

export function specialRequestLabels(requests: StoredSpecialRequests | null): string[] {
  return requests ? requests.codes.map((code) => SPECIAL_REQUEST_LABELS[code]) : []
}
