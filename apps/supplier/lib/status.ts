import type { StatusTone } from './types'

const TONES: Record<string, StatusTone> = {
  ACTIVE: 'success', APPROVED: 'success', CONFIRMED: 'success', PUBLISHED: 'success', MAPPED: 'success', LIVE: 'success', COMPLETE: 'success', COMPLETED: 'success', CHECKED_OUT: 'success', LOADED: 'success',
  PENDING: 'warning', PENDING_SUPPLIER: 'warning', ON_REQUEST: 'warning', DRAFT: 'warning', IN_REVIEW: 'warning', REVIEW: 'warning', PARTIAL: 'warning', AMEND_REQUESTED: 'warning', CANCEL_REQUESTED: 'warning', NEEDS_REVIEW: 'warning',
  REJECTED: 'danger', FAILED: 'danger', CANCELLED: 'danger', NO_SHOW: 'danger', UNMAPPED: 'danger', EXPIRED: 'danger', SUSPENDED: 'danger', ERROR: 'danger', MISMATCH: 'danger',
}

/** Badge colour for a status key from the API. Unknown values are neutral, never green: an unrecognised state must not look healthy. */
export function statusTone(status: string): StatusTone {
  return TONES[status.trim().toUpperCase().replace(/[\s-]+/g, '_')] ?? 'neutral'
}

const LABELS: Record<string, string> = {
  PENDING_SUPPLIER: 'Awaiting your answer',
}

/** Human label: "ON_REQUEST" becomes "On request". PENDING_SUPPLIER reads from the supplier's side. */
export function statusLabel(status: string): string {
  const key = status.trim().toUpperCase()
  if (LABELS[key]) return LABELS[key]
  const words = status.replace(/_/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Statuses a supplier can still answer (confirm, put on request or reject). Mirrors the booking detail page. */
export function needsSupplierAnswer(status: string): boolean {
  return status === 'PENDING_SUPPLIER' || status === 'ON_REQUEST'
}

/** Two-letter initials for avatar tiles, e.g. "Grand Hyatt Dubai" gives "GH". */
export function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '··'
}
