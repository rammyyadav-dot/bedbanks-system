'use client'

import Link from 'next/link'
import type { BookingListQuery, BookingListRow } from '@bedbanks/contracts'
import { Money, Tag, bookingTone } from '@/components/ops/ops-ui'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getOpsBookings } from '@/lib/data/operations'
import { bookingHref, deadlineUrgency } from '@/lib/booking-ui'
import { KANBAN_CARD_LIMIT, kanbanListQuery, kanbanOverflow, kanbanParams, kanbanTitle, visibleKanbanStatuses, type KanbanStatus } from '@/lib/booking-kanban-ui'

const small: React.CSSProperties = { display: 'block', color: '#3f565c', fontSize: 10, marginTop: 2 }
const accent = (status: KanbanStatus) => ({ ok: '#22a58a', warn: '#d9962b', bad: '#c0443f', neutral: '#8aa0a6' }[bookingTone(status)])

/**
 * The Bookings board (ADR 0039, Phase 6D). One column per working status, each loaded independently from the same list API with the person's filters, so one slow or
 * failed column never hides the others, and a failure is shown as a failure (never as an empty column). Read-only: a card opens the booking, where the transition dialogs and every
 * legal action live. Cards show what the API sent, already masked for the caller.
 */
export function BookingsKanban({ query, now }: { query: BookingListQuery; now: Date }) {
  const statuses = visibleKanbanStatuses(query)
  if (statuses.length === 0) return <div className="workspace-panel" data-testid="kanban-empty" style={{ padding: 18, fontSize: 12 }}>The board shows working statuses only. Your status filter selects none of them; clear it, or use the list.</div>
  return (
    <div data-testid="kanban" role="region" aria-label="Bookings board" tabIndex={0} style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(250px, 1fr)', gap: 10, overflowX: 'auto', paddingBottom: 8 }}>
      {statuses.map((status) => <KanbanColumn key={status} status={status} query={query} now={now} />)}
    </div>
  )
}

function KanbanColumn({ status, query, now }: { status: KanbanStatus; query: BookingListQuery; now: Date }) {
  const params = kanbanParams(query, status)
  const key = JSON.stringify(params)
  const { state, reload } = useOpsQuery(() => getOpsBookings(params), [key])
  return (
    <section aria-label={kanbanTitle(status)} data-testid="kanban-column" data-status={status} style={{ background: '#f5f8f9', border: '1px solid #e1eaec', borderTop: `3px solid ${accent(status)}`, borderRadius: 6, padding: 8, minHeight: 120 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '2px 4px 8px' }}>
        <strong style={{ fontSize: 12 }}>{kanbanTitle(status)}</strong>
        <span data-testid="kanban-count" style={{ fontSize: 11, color: '#3f565c' }}>{state.status === 'ready' ? state.data.total : '…'}</span>
      </header>
      <OpsState state={state} onRetry={reload}>
        {(data) => data.items.length === 0
          ? <p style={{ fontSize: 11, color: '#3f565c', margin: '6px 4px' }}>Nothing here.</p>
          : (
            <>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {data.items.map((row) => <li key={row.id}><KanbanCard row={row} now={now} /></li>)}
              </ul>
              {kanbanOverflow(data.total, data.items.length) > 0 && (
                <p style={{ fontSize: 11, margin: '8px 4px 2px' }}>Showing the first {KANBAN_CARD_LIMIT}. <Link href={bookingHref(kanbanListQuery(query, status))}>Show all {data.total} in the list</Link></p>
              )}
            </>
          )}
      </OpsState>
    </section>
  )
}

function KanbanCard({ row, now }: { row: BookingListRow; now: Date }) {
  const urgency = deadlineUrgency(row.cancelDeadline, now)
  return (
    <Link href={`/bookings/${row.id}`} data-testid="kanban-card" aria-label={`Open booking ${row.reference}`} style={{ display: 'block', background: '#fff', border: '1px solid #e1eaec', borderRadius: 5, padding: '8px 10px', color: 'inherit', textDecoration: 'none', fontSize: 11 }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}><strong>{row.reference}</strong><Money minor={row.sellMinor} currency={row.currency} /></span>
      <span style={small}>{row.hotel.name ?? 'Hotel not readable'}</span>
      <span style={small}>{row.leadGuest ? row.leadGuest.name : '—'}{row.guests ? ` · ${row.guests.adults} AD${row.guests.children ? ` · ${row.guests.children} C` : ''}` : ''}</span>
      <span style={small}>{row.checkIn ? `Check-in ${row.checkIn}` : 'No stay dates'}{row.nights ? ` · ${row.nights}n` : ''}</span>
      <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
        {row.missingSupplierRef && <Tag tone="bad">No supplier ref</Tag>}
        {row.isRefundable === false && <Tag tone="warn">NR</Tag>}
        {urgency === 'soon' && <Tag tone="bad">Deadline &lt; 48h</Tag>}
        {row.amended && <Tag tone="neutral">AMENDED</Tag>}
      </span>
      <span style={small}>{row.agency?.name ?? 'Unassigned agency'}{row.assignedTo ? ` · owner ${row.assignedTo.name}` : ''}</span>
    </Link>
  )
}
