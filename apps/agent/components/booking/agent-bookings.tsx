'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BookingService, type BookingDetail, type BookingPage, type CancellationQuote, type DocumentType } from '@/services/booking-service'
import { agentFacingBooking, supplierReferenceForAgent } from '@/lib/booking-attention'
import { formatMinorAmount, formatStay } from '@/lib/format'

const FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'PENDING', label: 'Pending' },
  { id: 'CONFIRMED', label: 'Confirmed' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'FAILED', label: 'Not confirmed' },
] as const
type BookingFilter = typeof FILTERS[number]['id']
const PAGE_SIZE = 20

export function Bookings({ tenantId, bookingEnabled, initialBookingId, onSearch, onChanged, service }: {
  tenantId: string; bookingEnabled: boolean; initialBookingId?: string | null; onSearch: () => void; onChanged: () => void; service?: BookingService
}) {
  const api = useRef(service ?? new BookingService()).current
  const [page, setPage] = useState<BookingPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialBookingId ?? null)
  const [detail, setDetail] = useState<BookingDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [quote, setQuote] = useState<CancellationQuote | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState<BookingFilter>('ALL')

  const loadList = useCallback(async () => {
    const result = await api.list(tenantId, { limit: PAGE_SIZE, offset, status: filter === 'ALL' ? undefined : filter })
    if (result.ok) { setPage(result.data); setListError('') } else { setPage(null); setListError(result.message) }
  }, [api, tenantId, offset, filter])
  const loadDetail = useCallback(async (id: string) => {
    setDetail(null); setDetailError(''); setQuote(null)
    const result = await api.detail(id, tenantId)
    if (result.ok) setDetail(result.data); else setDetailError(result.message)
  }, [api, tenantId])
  useEffect(() => { if (bookingEnabled) void loadList() }, [bookingEnabled, loadList])
  useEffect(() => { if (bookingEnabled && selectedId) void loadDetail(selectedId) }, [bookingEnabled, selectedId, loadDetail])

  if (!bookingEnabled) return <section className="portal-empty"><h1>My bookings</h1><p>Booking is not enabled for this workspace yet. Nothing has been booked and no booking history is shown.</p><button className="portal-primary" onClick={onSearch}>New search</button></section>

  async function openDocument(type: DocumentType) {
    if (!detail) return
    setBusy(true); setNotice('')
    const popup = window.open('', '_blank')
    const result = await api.documentHtml(detail.id, type, tenantId)
    if (result.ok && popup) { popup.location.href = URL.createObjectURL(new Blob([result.data], { type: 'text/html' })) }
    else { popup?.close(); setNotice(result.ok ? 'Allow pop-ups to open the document.' : result.message) }
    setBusy(false)
    void loadDetail(detail.id)
  }
  async function requestQuote() {
    if (!detail) return
    setBusy(true); setNotice('')
    const result = await api.cancellationQuote(detail.id, tenantId)
    if (result.ok) setQuote(result.data); else setNotice(result.message)
    setBusy(false)
  }
  async function confirmCancel() {
    if (!detail || !quote) return
    setBusy(true); setNotice('')
    const result = await api.cancel(detail.id, 'Cancelled by agent', tenantId)
    if (result.ok) { setQuote(null); setNotice(`Booking cancelled. ${formatMinorAmount(result.data.refundMinor, result.data.currency) ?? ''} credited to your wallet.`); onChanged(); await Promise.all([loadList(), loadDetail(detail.id)]) }
    else setNotice(result.message)
    setBusy(false)
  }

  const money = (minor: string, currency: string) => formatMinorAmount(minor, currency) ?? 'Amount unavailable'
  const has = (type: string) => detail?.documents.some((doc) => doc.type === type) ?? false
  const rows = page?.items ?? []
  const face = detail ? agentFacingBooking(detail.status, detail.supplierMutation?.status) : null
  const supplierReference = detail ? supplierReferenceForAgent(detail.status, detail.supplierMutation) : null
  const timeline = detail?.timeline?.length ? detail.timeline : (detail ? [{ type: 'recorded' as const, at: detail.createdAt }] : [])
  const windowStart = page && page.total > 0 ? page.offset + 1 : 0
  const windowEnd = page ? page.offset + page.items.length : 0
  return <section className="portal-bookings"><div className="portal-heading-row"><div><span className="portal-eyebrow">TRANSACTIONS</span><h1>My bookings</h1><p>Newest bookings for this agency. The list is paged on the server.</p></div><button className="portal-primary" onClick={onSearch}>New search</button></div>
    {listError && <p className="portal-field-error" role="alert">{listError}</p>}
    {page === null && !listError && <p role="status">Loading bookings…</p>}
    {page !== null && <div className="market-recheck-actions" role="tablist" aria-label="Booking status">{FILTERS.map((item) => <button key={item.id} type="button" className="portal-link" aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setOffset(0) }}>{item.label}</button>)}</div>}
    {page !== null && page.total > 0 && <p role="status">Showing {windowStart}–{windowEnd} of {page.total} bookings</p>}
    {page !== null && page.total === 0 && <div className="portal-empty"><p>No bookings yet.</p></div>}
    {rows.length > 0 && <div className="portal-panel booking-table-wrap"><table className="booking-table" aria-label="Bookings"><thead><tr><th>fBeds reference</th><th>Hotel</th><th>Stay</th><th>Lead guest</th><th>Total</th><th>Status</th><th>Recorded</th></tr></thead>
      <tbody>{rows.map((row) => { const rowFace = agentFacingBooking(row.status); return <tr key={row.id} className={row.id === selectedId ? 'is-selected' : ''}><td><button className="portal-link" onClick={() => setSelectedId(row.id)}>{row.reference}</button></td><td>{row.hotelName ?? '—'}</td><td>{row.checkIn && row.checkOut ? formatStay(row.checkIn, row.checkOut) : '—'}</td><td>{row.leadGuest ?? '—'}</td><td>{money(row.totalMinor, row.currency)} {row.currency}</td><td><span className={`booking-status is-${row.status.toLowerCase()}`}>{rowFace.label}</span></td><td>{typeof row.createdAt === 'string' ? row.createdAt.slice(0, 10) : '—'}</td></tr> })}</tbody></table></div>}
    {page !== null && page.total > page.limit && <nav className="market-recheck-actions" aria-label="Booking pages"><button type="button" className="portal-link" disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>Previous</button><button type="button" className="portal-link" disabled={page.offset + page.items.length >= page.total} onClick={() => setOffset(page.offset + page.limit)}>Next</button></nav>}
    {selectedId && <div className="portal-panel booking-detail" aria-label="Booking detail">
      {detailError && <p className="portal-field-error" role="alert">{detailError}</p>}
      {!detail && !detailError && <p role="status">Loading booking…</p>}
      {detail && face && <><h2>{detail.reference} <span className={`booking-status is-${detail.status.toLowerCase()}`}>{face.label}</span></h2>
        {face.attention && <p role="status">{face.message}</p>}
        <h3>Stay</h3>
        <p>{detail.hotelName ?? 'Hotel'} · {detail.checkIn && detail.checkOut ? formatStay(detail.checkIn, detail.checkOut) : '—'} · {detail.rooms ?? '—'} room · {detail.adults ?? '—'} adults{detail.children ? `, ${detail.children} children` : ''}</p>
        <h3>Guest</h3>
        <p>Lead guest {detail.leadGuest ?? '—'}</p>
        <h3>Commercial</h3>
        <p><b>{money(detail.totalMinor, detail.currency)}</b> {detail.currency}{supplierReference ? ` · supplier reference ${supplierReference}` : ''}</p>
        <h3>Record</h3>
        <ul>{timeline.map((event) => <li key={`${event.type}-${event.at}`}>{event.type === 'cancelled' ? 'Booking cancelled' : 'Booking recorded'} {event.at}</li>)}<li>Current status {face.label}</li></ul>
        <div className="booking-actions">
          {detail.status === 'CONFIRMED' && <><button className="portal-primary" disabled={busy} onClick={() => void openDocument('voucher')}>Voucher</button><button className="portal-link" disabled={busy} onClick={() => void openDocument('invoice')}>Invoice</button></>}
          {detail.status === 'CANCELLED' && <>{has('VOUCHER') && <button className="portal-link" disabled={busy} onClick={() => void openDocument('voucher')}>Voucher (cancelled)</button>}{has('INVOICE') && <button className="portal-link" disabled={busy} onClick={() => void openDocument('invoice')}>Invoice</button>}<button className="portal-primary" disabled={busy} onClick={() => void openDocument('credit-note')}>Credit note</button></>}
          {detail.cancellable && !quote && <button className="portal-link danger" disabled={busy} onClick={() => void requestQuote()}>Cancel booking…</button>}
        </div>
        {quote && <div className="portal-hold-panel" role="alertdialog" aria-label="Confirm cancellation"><div><span>Cancelling now: penalty <b>{money(quote.penaltyMinor, quote.currency)}</b>, refund <b>{money(quote.refundMinor, quote.currency)}</b> to your wallet, from a total of {money(quote.totalMinor, quote.currency)}. This cannot be undone.</span></div>
          <div className="booking-actions"><button className="portal-primary" disabled={busy} onClick={() => void confirmCancel()}>{busy ? 'Cancelling…' : 'Yes, cancel this booking'}</button><button className="portal-link" disabled={busy} onClick={() => setQuote(null)}>Keep booking</button></div></div>}
        {notice && <p role="status" className="booking-note">{notice}</p>}</>}
    </div>}
  </section>
}
