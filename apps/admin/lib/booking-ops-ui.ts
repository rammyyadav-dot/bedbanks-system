// Pure helpers for the operations queue screens (ADR 0039, Phase 4). No React, no network. Every rule about SLA, priority and reasons lives in @bedbanks/contracts;
// this file only formats what the API decided and builds the URL of a view.
import {
  BOOKING_OPS_PAGE_SIZES, BOOKING_OPS_PRIORITIES, BOOKING_OPS_REASONS, BOOKING_OPS_SLA_STATES, BOOKING_OPS_TABS, BOOKING_STATUSES,
  type BookingOpsPriority, type BookingOpsQueueQuery, type BookingOpsSlaState, type BookingOpsTab,
} from '@bedbanks/contracts'

/** "overdue by 37 minutes", "due in 2 h 5 min": derived from the API's remaining seconds, never stored. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return '—'
  const overdue = seconds < 0; const abs = Math.abs(seconds)
  const d = Math.floor(abs / 86_400); const h = Math.floor((abs % 86_400) / 3600); const m = Math.floor((abs % 3600) / 60)
  const span = d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min` : abs > 0 ? 'under a minute' : 'now'
  return abs === 0 ? 'due now' : overdue ? `overdue by ${span}` : `due in ${span}`
}
export const slaTone = (s: BookingOpsSlaState | null): 'ok' | 'warn' | 'bad' | 'neutral' => (s === 'BREACHED' ? 'bad' : s === 'DUE_SOON' ? 'warn' : s === 'WITHIN_SLA' ? 'ok' : 'neutral')
export const priorityTone = (p: BookingOpsPriority): 'ok' | 'warn' | 'bad' | 'neutral' => (p === 'CRITICAL' || p === 'URGENT' ? 'bad' : p === 'HIGH' ? 'warn' : 'neutral')

const csv = (v: string | null) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const list = <T extends string>(v: string | null, allowed: readonly T[]): T[] | undefined => { const out = csv(v).filter((x): x is T => (allowed as readonly string[]).includes(x)); return out.length ? out : undefined }
const DAY = /^\d{4}-\d{2}-\d{2}$/
const realDay = (v: string) => DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
export const BOOKING_OPS_QUERY_KEYS = ['tab', 'reference', 'agencyId', 'supplier', 'status', 'supplierStatus', 'reason', 'priority', 'assignee', 'sla', 'checkInFrom', 'checkInTo', 'createdFrom', 'createdTo', 'page', 'pageSize'] as const

/** Reads the URL into a query. Unknown or malformed values are dropped (the API would refuse them), never carried along. */
export function readOpsQuery(params: URLSearchParams): BookingOpsQueueQuery {
  const q: BookingOpsQueueQuery = {}
  const tab = params.get('tab'); if (tab && (BOOKING_OPS_TABS as readonly string[]).includes(tab)) q.tab = tab as BookingOpsTab
  const text = (k: 'reference' | 'agencyId' | 'supplier' | 'supplierStatus' | 'assignee', re: RegExp) => { const v = params.get(k); if (v && re.test(v)) q[k] = v }
  text('reference', /^[A-Za-z0-9._:-]{3,64}$/); text('agencyId', /^[A-Za-z0-9_-]{1,64}$/); text('supplier', /^.{1,80}$/); text('supplierStatus', /^[A-Z_]{2,40}$/); text('assignee', /^(me|none|[A-Za-z0-9_-]{1,64})$/)
  const status = list(params.get('status'), BOOKING_STATUSES); if (status) q.status = status
  const reason = list(params.get('reason'), BOOKING_OPS_REASONS); if (reason) q.reason = reason
  const priority = list(params.get('priority'), BOOKING_OPS_PRIORITIES); if (priority) q.priority = priority
  const sla = list(params.get('sla'), BOOKING_OPS_SLA_STATES); if (sla) q.sla = sla
  for (const k of ['checkInFrom', 'checkInTo', 'createdFrom', 'createdTo'] as const) { const v = params.get(k); if (v && realDay(v)) q[k] = v }
  const page = Number(params.get('page')); if (Number.isInteger(page) && page > 1) q.page = page
  const size = Number(params.get('pageSize')); if ((BOOKING_OPS_PAGE_SIZES as readonly number[]).includes(size)) q.pageSize = size as (typeof BOOKING_OPS_PAGE_SIZES)[number]
  return q
}
/** The query string of a view, keys in a fixed order so a shared link is identical however it was built. Default tab and page are omitted. */
export function opsQueryString(q: BookingOpsQueueQuery): string {
  const p = new URLSearchParams()
  for (const k of BOOKING_OPS_QUERY_KEYS) {
    const v = q[k]; if (v === undefined || v === '') continue
    if (k === 'tab' && v === 'active') continue
    if (k === 'page' && Number(v) <= 1) continue
    p.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  const s = p.toString(); return s ? `?${s}` : ''
}
/** Changing any filter returns to page 1; changing only the page keeps the rest. */
export function withOpsFilters(q: BookingOpsQueueQuery, patch: Partial<BookingOpsQueueQuery>): BookingOpsQueueQuery {
  const next = { ...q, ...patch }; if (!('page' in patch)) delete next.page
  for (const k of Object.keys(next) as Array<keyof BookingOpsQueueQuery>) if (next[k] === undefined || next[k] === '' || (Array.isArray(next[k]) && (next[k] as unknown[]).length === 0)) delete next[k]
  return next
}
