'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { BookingService, type BookingDetail, type BookingPage, type CancellationQuote, type DocumentType } from '@/services/booking-service'
import { agentFacingBooking, supplierReferenceForAgent } from '@/lib/booking-attention'
import { recoveryLines } from '@/lib/booking-recovery'
import { cancellationQuoteFresh } from '@/lib/checkout-guard'
import { replaceDocumentUrl, revokeDocumentUrl } from '@/lib/document-url'
import { formatMinorAmount, formatOfferExpiry, formatStay } from '@/lib/format'
import type { PortalAccess } from '@/lib/portal-access'
import { shouldApplyTenantResponse } from '@/lib/tenant-response'
import { LAUNCH_BUSINESS_TIME_ZONE } from '@/lib/business-time'

const FILTERS = [
  { id: 'ALL', label: 'All' },
  { id: 'PENDING', label: 'Pending' },
  { id: 'CONFIRMED', label: 'Confirmed' },
  { id: 'CANCELLED', label: 'Cancelled' },
  { id: 'FAILED', label: 'Not confirmed' },
] as const
type BookingFilter = typeof FILTERS[number]['id']
const PAGE_SIZE = 20

export function Bookings({ tenantId, access, initialBookingId, onSearch, onChanged, service }: {
  tenantId: string; access: PortalAccess; initialBookingId?: string | null; onSearch: () => void; onChanged: () => void; service?: BookingService
}) {
  const api = useRef(service ?? new BookingService()).current
  const tenantRef = useRef(tenantId)
  tenantRef.current = tenantId
  const documentUrl = useRef<string | null>(null)
  const cancelDialog = useRef<HTMLDivElement>(null)
  const cancelTitleId = useId()
  const returnFocus = useRef<HTMLElement | null>(null)
  const busyRef = useRef(false)
  useEffect(() => () => revokeDocumentUrl(documentUrl), [])
  const [page, setPage] = useState<BookingPage | null>(null)
  const [offset, setOffset] = useState(0)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialBookingId ?? null)
  const [detail, setDetail] = useState<BookingDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [quote, setQuote] = useState<CancellationQuote | null>(null)
  const [busy, setBusy] = useState(false)
  const [recovering, setRecovering] = useState(false)
  busyRef.current = busy
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState<BookingFilter>('ALL')
  const [recovery, setRecovery] = useState<string[]>([])

  const loadList = useCallback(async () => {
    const requested = tenantId
    const result = await api.list(requested, { limit: PAGE_SIZE, offset, status: filter === 'ALL' ? undefined : filter })
    if (!shouldApplyTenantResponse(requested, tenantRef.current)) return
    if (result.ok) { setPage(result.data); setListError('') } else { setPage(null); setListError(result.message) }
  }, [api, tenantId, offset, filter])
  const loadDetail = useCallback(async (id: string) => {
    const requested = tenantId
    setDetail(null); setDetailError(''); setQuote(null)
    const result = await api.detail(id, requested)
    if (!shouldApplyTenantResponse(requested, tenantRef.current)) return
    if (result.ok) setDetail(result.data); else setDetailError(result.message)
  }, [api, tenantId])
  useEffect(() => { if (access.viewBookings.enabled) void loadList() }, [access.viewBookings.enabled, loadList])
  useEffect(() => { if (access.viewBookings.enabled && selectedId) void loadDetail(selectedId) }, [access.viewBookings.enabled, selectedId, loadDetail])
  useEffect(() => {
    if (!quote) {
      const back = returnFocus.current
      returnFocus.current = null
      back?.focus()
      return
    }
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = cancelDialog.current
    node?.querySelector('button')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (busyRef.current) return
        event.preventDefault()
        setQuote(null)
        return
      }
      if (event.key !== 'Tab' || !node) return
      const items = [...node.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quote])

  const recoveryPanel = <>
    {access.recover.enabled && <div className="portal-hold-panel"><div><strong>Recovery</strong><span>Closes interrupted holds that are old enough. A fulfilled supplier booking still inside its confirmation window is left in place.</span></div><button type="button" className="portal-link" disabled={busy} onClick={() => void recover()}>{recovering ? 'Recovering…' : 'Run recovery'}</button></div>}
    {access.recover.shown && !access.recover.enabled && <p role="status">{access.recover.message}</p>}
    {recovery.length > 0 && <ul>{recovery.map((line) => <li key={line}>{line}</li>)}</ul>}
  </>
  if (!access.viewBookings.enabled) return <section className="portal-empty" role="status"><h1>My bookings</h1><p>{access.viewBookings.message || 'Booking history is not available for this workspace yet. Nothing has been booked and no booking history is shown.'}</p>{recoveryPanel}{notice && <p role="status" className="booking-note">{notice}</p>}<button className="portal-primary" onClick={onSearch}>New search</button></section>

  async function openDocument(type: DocumentType) {
    if (!detail || busy) return
    if (!access.documents.enabled) { setNotice(access.documents.message || 'Booking documents are not available.'); return }
    setBusy(true); setNotice('')
    const popup = window.open('', '_blank')
    const result = await api.documentHtml(detail.id, type, tenantId)
    if (result.ok && popup) { popup.location.href = replaceDocumentUrl(documentUrl, result.data) }
    else { popup?.close(); setNotice(result.ok ? 'Allow pop-ups to open the document.' : result.message) }
    setBusy(false)
    void loadDetail(detail.id)
  }
  async function recover() {
    if (busy || !access.recover.enabled) return
    setBusy(true); setRecovering(true); setNotice(''); setRecovery([])
    const result = await api.recover(tenantId)
    if (result.ok) {
      setRecovery(recoveryLines(result.data.items))
      if (result.data.examined > 0) setNotice(`Recovery examined ${result.data.examined} hold${result.data.examined === 1 ? '' : 's'}.`)
      if (access.viewBookings.enabled) {
        await loadList()
        if (selectedId) await loadDetail(selectedId)
      }
    } else setNotice(result.message)
    setRecovering(false); setBusy(false)
  }
  async function requestQuote() {
    if (!detail || busy || !access.cancel.enabled) return
    setBusy(true); setNotice('')
    const result = await api.cancellationQuote(detail.id, tenantId)
    if (result.ok) setQuote(result.data); else setNotice(result.message)
    setBusy(false)
  }
  async function confirmCancel() {
    if (!detail || !quote || busy) return
    if (!cancellationQuoteFresh(quote.evaluatedAt, Date.now())) { setQuote(null); setNotice('This cancellation quote is out of date. Request a new quote before cancelling.'); return }
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
    {recoveryPanel}
    {listError && <p className="portal-field-error" role="alert">{listError} <button type="button" className="portal-link" onClick={() => void loadList()}>Retry</button></p>}
    {page === null && !listError && <p role="status">Loading bookings…</p>}
    {page !== null && <div className="market-recheck-actions" role="tablist" aria-label="Booking status">{FILTERS.map((item) => <button key={item.id} type="button" className="portal-link" aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setOffset(0) }}>{item.label}</button>)}</div>}
    {page !== null && page.total > 0 && <p role="status">Showing {windowStart}–{windowEnd} of {page.total} bookings</p>}
    {page !== null && page.total === 0 && <div className="portal-empty"><p>No bookings yet.</p></div>}
    {rows.length > 0 && <div className="portal-panel booking-table-wrap"><table className="booking-table" aria-label="Bookings"><thead><tr><th>fabBeds reference</th><th>Hotel</th><th>Stay</th><th>Lead guest</th><th>Total</th><th>Status</th><th>Recorded</th></tr></thead>
      <tbody>{rows.map((row) => { const rowFace = agentFacingBooking(row.status); return <tr key={row.id} className={row.id === selectedId ? 'is-selected' : ''}><td><button className="portal-link" onClick={() => setSelectedId(row.id)}>{row.reference}</button></td><td>{row.hotelName ?? '—'}</td><td>{row.checkIn && row.checkOut ? formatStay(row.checkIn, row.checkOut) : '—'}</td><td>{row.leadGuest ?? '—'}</td><td>{money(row.totalMinor, row.currency)}</td><td><span className={`booking-status is-${row.status.toLowerCase()}`}>{rowFace.label}</span></td><td>{formatOfferExpiry(row.createdAt, LAUNCH_BUSINESS_TIME_ZONE) ?? '—'}</td></tr> })}</tbody></table></div>}
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
        <p><b>{money(detail.totalMinor, detail.currency)}</b>{supplierReference ? ` · supplier reference ${supplierReference}` : ''}</p>
        <h3>Record</h3>
        <ul>{timeline.map((event) => <li key={`${event.type}-${event.at}`}>{event.type === 'cancelled' ? 'Booking cancelled' : 'Booking recorded'} {formatOfferExpiry(event.at, LAUNCH_BUSINESS_TIME_ZONE) ?? event.at}</li>)}<li>Current status {face.label}</li></ul>
        <div className="booking-actions">
          {access.documents.enabled && detail.status === 'CONFIRMED' && <><button className="portal-primary" disabled={busy} onClick={() => void openDocument('voucher')}>Voucher</button><button className="portal-link" disabled={busy} onClick={() => void openDocument('invoice')}>Invoice</button></>}
          {access.documents.enabled && detail.status === 'CANCELLED' && <>{has('VOUCHER') && <button className="portal-link" disabled={busy} onClick={() => void openDocument('voucher')}>Voucher (cancelled)</button>}<button className="portal-link" disabled={busy} onClick={() => void openDocument('invoice')}>Invoice</button><button className="portal-primary" disabled={busy} onClick={() => void openDocument('credit-note')}>Credit note</button></>}
          {access.documents.shown && !access.documents.enabled && <p role="status">{access.documents.message}</p>}
          {access.cancel.enabled && detail.cancellable && !quote && <button className="portal-link danger" disabled={busy} onClick={() => void requestQuote()}>Cancel booking…</button>}
          {access.cancel.shown && !access.cancel.enabled && detail.cancellable && <p role="status">{access.cancel.message}</p>}
        </div>
        {quote && <div ref={cancelDialog} className="portal-hold-panel" role="alertdialog" aria-modal="true" aria-labelledby={cancelTitleId}><div><strong id={cancelTitleId}>Confirm cancellation</strong><span>Cancelling now: penalty <b>{money(quote.penaltyMinor, quote.currency)}</b>, refund <b>{money(quote.refundMinor, quote.currency)}</b> to your wallet, from a total of {money(quote.totalMinor, quote.currency)}. This cannot be undone.</span></div>
          <div className="booking-actions"><button className="portal-primary" disabled={busy} onClick={() => void confirmCancel()}>{busy ? 'Cancelling…' : 'Yes, cancel this booking'}</button><button className="portal-link" disabled={busy} onClick={() => setQuote(null)}>Keep booking</button></div></div>}
        {notice && <p role="status" className="booking-note">{notice}</p>}</>}
    </div>}
  </section>
}
