'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { BOOKING_PAGE_SIZES, BOOKING_QUICK_SEARCH_LABEL, BOOKING_QUICK_SEARCHES, type BookingBulkAction, type BookingListQuery, type BookingListPage } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getAgencies } from '@/lib/data/departments'
import { getOpsBookings } from '@/lib/data/operations'
import { BOOKING_COLUMN_LABEL, BOOKING_COLUMNS_STORAGE_KEY, DEFAULT_BOOKING_COLUMNS, bookingHref, bookingQueryString, effectiveChip, normalizeColumns, readBookingQuery, withFilters, type BookingColumnId } from '@/lib/booking-ui'
import { VIEW_PARAM, viewHref, withView } from '@/lib/booking-views-ui'
import { bulkCapabilities, EMPTY_SELECTION, failedIds, pageSelectionState, toggleSelected, togglePage, type Selection } from '@/lib/booking-bulk-ui'
import { BulkDialog, BulkToolbar } from './BulkActions'
import { BookingCell } from './BookingCells'
import { BookingFilters } from './BookingFilters'
import { ColumnPicker } from './ColumnPicker'
import { SavedViews } from './SavedViews'

function loadColumns(): BookingColumnId[] {
  try { const raw = window.localStorage.getItem(BOOKING_COLUMNS_STORAGE_KEY); return raw ? normalizeColumns(JSON.parse(raw)) : [...DEFAULT_BOOKING_COLUMNS] } catch { return [...DEFAULT_BOOKING_COLUMNS] }
}

/**
 * All Bookings (ADR 0039, Phase 1): read-only, server-filtered, server-paginated. The page opens on Needs action. Every filter is in the URL so a view can
 * be shared. Loading, empty, forbidden, not-readable and error are distinct states, and a failure is never shown as "no bookings".
 */
export function BookingsWorkspace() {
  const router = useRouter()
  const search = useSearchParams()
  const query = useMemo(() => readBookingQuery(new URLSearchParams(search.toString())), [search])
  const chip = effectiveChip(query)
  const apiQuery: BookingListQuery = useMemo(() => ({ ...query, chip }), [query, chip])
  const apiString = bookingQueryString(apiQuery)
  const { state, reload } = useOpsQuery(() => getOpsBookings(Object.fromEntries(new URLSearchParams(apiString.replace(/^\?/, '')))), [apiString])
  const [columns, setColumns] = useState<BookingColumnId[]>([...DEFAULT_BOOKING_COLUMNS])
  const [last, setLast] = useState<BookingListPage | null>(null)
  const [now, setNow] = useState(() => new Date())
  // Explicit selection of booking ids (kept across pages, never a "select all matching"). The server judges every booking again.
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION)
  const [bulk, setBulk] = useState<BookingBulkAction | null>(null)
  const capabilities = bulkCapabilities(last?.access ?? null)
  useEffect(() => { setColumns(loadColumns()) }, [])
  useEffect(() => { if (state.status === 'ready') { setLast(state.data); setNow(new Date()) } }, [state])
  const agencies = useOpsQuery(() => getAgencies({ pageSize: 100 }).then((p) => p.items.map((a) => ({ id: a.id, name: a.name }))).catch(() => null), [])

  // The active saved view is a UI marker in the URL; the list API never receives it (the query reader only knows filter keys).
  const viewId = search.get(VIEW_PARAM)
  const go = (change: Partial<BookingListQuery>, keepPage = false) => router.replace(withView(bookingHref(keepPage ? { ...query, ...change } : withFilters(query, change)), viewId), { scroll: false })
  const saveColumns = (next: BookingColumnId[]) => { setColumns(next); try { window.localStorage.setItem(BOOKING_COLUMNS_STORAGE_KEY, JSON.stringify(next)) } catch { /* storage unavailable: the choice lasts for this visit */ } }
  const clearFilters = () => router.replace(bookingHref({ chip: 'latest' }), { scroll: false })
  const openView = useCallback((view: Parameters<typeof viewHref>[0]) => {
    const href = viewHref(view)
    if (!href) return
    if (view.visibleColumns) setColumns(normalizeColumns(view.visibleColumns)) // shown for this visit; the person's own column choice is left alone
    router.replace(href, { scroll: false })
  }, [router])
  const markActive = useCallback((id: string | null) => router.replace(withView(bookingHref(query), id), { scroll: false }), [router, query])

  return (
    <div className="admin-page">
      <PageHeader eyebrow="BOOKINGS" title="Bookings" description="Every reservation across agencies and suppliers. Find, filter and open any booking; open one to act on it." />
      {last?.access.opsQueue && <p style={{ margin: '0 0 10px' }}><Link href="/bookings/queue" className="admin-btn" data-testid="open-ops-queue">Operations queue</Link></p>}
      {last?.access.manualEntry && <p style={{ margin: '0 0 10px' }}><Link href="/bookings/new" className="admin-btn" data-testid="new-manual-booking">Enter a booking manually</Link></p>}
      <SavedViews access={last?.access ?? null} query={apiQuery} columns={columns} activeId={viewId} urlIsBlank={search.toString() === ''} onOpen={openView} onActive={markActive}
        onReset={() => { setColumns(loadColumns()); router.replace('/bookings', { scroll: false }) }} />
      <nav aria-label="Quick searches" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '0 0 10px' }}>
        {BOOKING_QUICK_SEARCHES.map((c) => (
          <button key={c} type="button" className="admin-btn" aria-pressed={chip === c} style={chip === c ? { background: '#0d2631', color: '#fff', borderColor: '#0d2631' } : undefined} onClick={() => go({ chip: c })}>{BOOKING_QUICK_SEARCH_LABEL[c]}</button>
        ))}
      </nav>
      {chip === 'needsAction' && <p style={{ color: '#3f565c', fontSize: 11, margin: '0 0 8px' }}>Needs action here means: pending supplier, on request, amendment or cancellation requested, failed, or confirmed with no supplier reference. For operational priority and SLA handling, open the Operations queue when enabled for your role.</p>}
      <BookingFilters query={query} access={last?.access ?? null} agencies={agencies.state.status === 'ready' ? agencies.state.data : null}
        onApply={(next) => router.replace(withView(bookingHref(withFilters({ chip: query.chip, sort: query.sort, dir: query.dir }, { ...next, chip: undefined })), viewId), { scroll: false })} onClear={clearFilters} />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', margin: '10px 0' }}>
        <span role="status" aria-live="polite" data-testid="result-count" style={{ fontSize: 12 }}>
          {state.status === 'ready' ? `${state.data.total} booking${state.data.total === 1 ? '' : 's'}` : state.status === 'loading' ? 'Loading…' : 'Not loaded'}
          {state.status === 'ready' && state.data.access.level === 'AGENCY' ? ' · your agency only' : ''}
          {state.status === 'ready' && state.data.scanCapped ? ' · the newest 500 were examined for reconciliation flags' : ''}
        </span>
        <ColumnPicker columns={columns} onChange={saveColumns} />
      </div>
      {capabilities.length > 0 && <BulkToolbar selection={selection} capabilities={capabilities} onClear={() => setSelection(EMPTY_SELECTION)} onStart={setBulk} />}
      {bulk && <BulkDialog action={bulk} selection={selection} onClose={() => setBulk(null)} onDone={(op) => { setSelection(new Set(failedIds(op))); reload() }} />}
      <OpsState state={state} onRetry={reload}>
        {(data) => data.items.length === 0
          ? <BookingEmpty data={data} onClear={clearFilters} />
          : <BookingTable data={data} columns={columns} now={now} selectable={capabilities.length > 0} selection={selection} onSelect={(id) => setSelection((s) => toggleSelected(s, id))} onSelectPage={(ids) => setSelection((s) => togglePage(s, ids))} onPage={(page) => go({ page }, true)} onSize={(pageSize) => go({ pageSize: pageSize === 25 ? undefined : pageSize })} />}
      </OpsState>
    </div>
  )
}

function BookingEmpty({ data, onClear }: { data: BookingListPage; onClear: () => void }) {
  return (
    <div className="workspace-panel" data-testid="booking-empty" data-state="empty" style={{ padding: 18 }}>
      <EmptyState title="No bookings match" description={data.applied.length ? 'These filters, applied together, removed every booking:' : 'The query succeeded and there are no bookings for you to see yet.'} />
      {data.applied.length > 0 && (
        <>
          <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12 }}>{data.applied.map((a) => <li key={a.key}><strong>{a.label}</strong>: {a.value}</li>)}</ul>
          <button type="button" className="admin-btn admin-btn-primary" onClick={onClear}>Clear filters</button>
        </>
      )}
    </div>
  )
}

function BookingTable({ data, columns, now, selectable, selection, onSelect, onSelectPage, onPage, onSize }: { data: BookingListPage; columns: BookingColumnId[]; now: Date; selectable: boolean; selection: Selection; onSelect: (id: string) => void; onSelectPage: (ids: string[]) => void; onPage: (page: number) => void; onSize: (size: number) => void }) {
  return (
    <div className="workspace-panel">
      <div style={{ overflowX: 'auto' }} role="region" aria-label="Bookings table" tabIndex={0}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }} aria-label="Bookings" data-testid="bookings-table">
          <thead><tr>{selectable && <th scope="col" style={{ padding: '10px 6px 10px 14px', width: 24 }}><PageCheckbox state={pageSelectionState(selection, data.items.map((r) => r.id))} onChange={() => onSelectPage(data.items.map((r) => r.id))} /></th>}{columns.map((c) => <th key={c} scope="col" style={{ textAlign: c === 'amount' ? 'right' : 'left', padding: '10px 14px', color: '#3f565c', borderBottom: '1px solid #e6eef0', whiteSpace: 'nowrap' }}>{BOOKING_COLUMN_LABEL[c]}</th>)}</tr></thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id} data-status={row.status} aria-selected={selectable ? selection.has(row.id) : undefined} style={{ borderBottom: '1px solid #edf2f3', background: selection.has(row.id) ? '#f1f7f9' : undefined }}>
                {selectable && <td style={{ padding: '10px 6px 10px 14px' }}><input type="checkbox" data-testid="row-select" data-booking-id={row.id} aria-label={`Select booking ${row.reference}`} checked={selection.has(row.id)} onChange={() => onSelect(row.id)} /></td>}
                {columns.map((c) => <td key={c} style={{ textAlign: c === 'amount' ? 'right' : 'left', padding: '10px 14px', color: '#2c4a55', verticalAlign: 'top' }}><BookingCell column={c} row={row} now={now} attentionAvailable={data.attentionAvailable} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '0 14px' }}>
        <label style={{ fontSize: 11 }}>Rows per page <select value={data.pageSize} onChange={(e) => onSize(Number(e.target.value))}>{BOOKING_PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={onPage} />
      </div>
      {!data.attentionAvailable && <p style={{ fontSize: 11, color: '#3f565c', padding: '0 14px 12px', margin: 0 }}>Reconciliation flags are not shown: the API database role cannot read the transaction records they come from. That is not the same as "no flags".</p>}
    </div>
  )
}

function PageCheckbox({ state, onChange }: { state: 'none' | 'some' | 'all'; onChange: () => void }) {
  return <input type="checkbox" data-testid="select-page" aria-label="Select all bookings on this page" checked={state === 'all'} ref={(el) => { if (el) el.indeterminate = state === 'some' }} onChange={onChange} />
}
