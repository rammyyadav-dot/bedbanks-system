// Pure helpers for the Bookings Kanban view (ADR 0039, Phase 6D). No React, no network.
// The board is a read-only view of the same list API: one column per working status, filled by the same query grammar. A card opens the booking, where the
// transition dialogs and every legal action already live; there is no drag-to-change-status, so the board cannot put a booking in a state the API would refuse.
import type { BookingListQuery, BookingStatus } from '@bedbanks/contracts'
import { statusLabel } from './booking-ui'

/** The spec's Kanban columns, left to right. */
export const KANBAN_STATUSES = ['ON_REQUEST', 'PENDING_SUPPLIER', 'CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'FAILED'] as const satisfies readonly BookingStatus[]
export type KanbanStatus = (typeof KANBAN_STATUSES)[number]
export const KANBAN_CARD_LIMIT = 25
export const KANBAN_VIEW_STORAGE_KEY = 'fbeds.admin.bookings.layout.v1'
export type BookingLayout = 'list' | 'kanban'

export const readLayout = (raw: string | null): BookingLayout => (raw === 'kanban' ? 'kanban' : 'list')
export const kanbanTitle = (status: KanbanStatus): string => statusLabel(status).toLowerCase().replace(/^./, (c) => c.toUpperCase())

/** The API query for one column: the person's filters, with the status fixed by the column and no chip or paging of their own. Work columns show the oldest first (longest waiting); Confirmed shows the soonest check-in. */
export function kanbanParams(query: BookingListQuery, status: KanbanStatus): Record<string, string> {
  const { chip: _chip, status: _status, page: _page, pageSize: _pageSize, sort, dir, ...rest } = query
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(rest)) if (value !== undefined && value !== null && value !== '' && value !== false) params[key] = String(value)
  params.status = status
  params.pageSize = String(KANBAN_CARD_LIMIT)
  params.sort = sort ?? (status === 'CONFIRMED' ? 'checkIn' : 'created')
  params.dir = dir ?? 'asc'
  return params
}

/** A person's own status filter narrows which columns have anything to show; an empty selection shows all columns. */
export function visibleKanbanStatuses(query: BookingListQuery): readonly KanbanStatus[] {
  const chosen = (query.status ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (chosen.length === 0) return KANBAN_STATUSES
  return KANBAN_STATUSES.filter((s) => chosen.includes(s))
}

/** How many bookings in a column are not on the board (the column shows the oldest 25). */
export const kanbanOverflow = (total: number, shown: number): number => Math.max(0, total - shown)

/** The list link for "show all" in a column: the same filters, that status, from page 1. */
export function kanbanListQuery(query: BookingListQuery, status: KanbanStatus): BookingListQuery {
  const { chip: _chip, page: _page, pageSize: _pageSize, ...rest } = query
  return { ...rest, status }
}
