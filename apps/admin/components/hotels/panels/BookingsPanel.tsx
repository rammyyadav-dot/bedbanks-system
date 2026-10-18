'use client'

import Link from 'next/link'
import { useState } from 'react'
import { BOOKING_STATUSES } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, bookingTone, when } from '@/components/ops/ops-ui'
import { getOpsBookings, getOpsHolds } from '@/lib/data/operations'
import { ScrollRegion, td, th, tableStyle } from '../ui'

/** Links into the existing booking and hold operations, filtered on the server by hotel. Booking 360 is not rebuilt here. */
export function BookingsPanel({ hotelId }: { hotelId: string }) {
  const holds = useOpsQuery(() => getOpsHolds({ hotelId, pageSize: 10 }), [hotelId])
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <HotelReservations hotelId={hotelId} />
      <div className="workspace-panel" style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><h2 style={{ fontSize: 14, margin: 0 }}>Inventory holds</h2><Link href={`/holds?hotelId=${encodeURIComponent(hotelId)}`}>All holds for this hotel</Link></div>
        <OpsState state={holds.state} onRetry={holds.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No holds for this hotel', description: 'The query succeeded and this hotel has no inventory holds.' }}>
          {(data) => (
            <ScrollRegion label="Hotel holds"><table style={tableStyle} aria-label="Hotel holds"><thead><tr>{['Hold', 'Status', 'Room', 'Stay', 'Amount', 'Expires'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{data.items.map((h) => <tr key={h.id}><td style={td}><Link href={`/holds/${h.id}`} style={{ fontWeight: 600 }}>{h.id}</Link></td><td style={td}><Tag tone={h.status === 'HELD' || h.status === 'CONFIRMED' ? 'ok' : h.status === 'PROCESSING' || h.status === 'HOLD_PENDING' ? 'warn' : 'neutral'}>{h.status}</Tag></td><td style={td}>{h.roomName ?? h.roomTypeId}</td><td style={td}>{h.checkIn} → {h.checkOut}</td><td style={td}><Money minor={h.sellAmountMinor} currency={h.currency} /></td><td style={td}>{when(h.expiresAt)}</td></tr>)}</tbody></table></ScrollRegion>
          )}
        </OpsState>
      </div>
    </div>
  )
}

function HotelReservations({ hotelId }: { hotelId: string }) {
  const [draft, setDraft] = useState({ reference: '', supplier: '', status: '', from: '', to: '' })
  const [filters, setFilters] = useState(draft)
  const [page, setPage] = useState(1)
  const bookings = useOpsQuery(() => getOpsBookings({ ...filters, hotelId, dateType: 'created', pageSize: 25, page }), [hotelId, filters.reference, filters.supplier, filters.status, filters.from, filters.to, page])
  return <section className="workspace-panel" style={{ padding: 18 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><h2 style={{ fontSize: 14, margin: 0 }}>All reservations</h2><Link href={`/bookings?hotelId=${encodeURIComponent(hotelId)}`}>Open booking workbench</Link></div>
    <p style={{ fontSize: 12 }}>Open a reservation for its saved price and terms, history, and permitted amendment or cancellation actions.</p>
    <form aria-label="Hotel reservation filters" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'end', marginBottom: 12 }} onSubmit={e => { e.preventDefault(); setFilters({ ...draft }); setPage(1) }}>
      <label>Reservation / supplier reference<input className="input-wrap" value={draft.reference} maxLength={80} onChange={e => setDraft({ ...draft, reference: e.target.value })} /></label>
      <label>Supplier code<input className="input-wrap" value={draft.supplier} maxLength={80} onChange={e => setDraft({ ...draft, supplier: e.target.value })} /></label>
      <label>Status<select value={draft.status} onChange={e => setDraft({ ...draft, status: e.target.value })}><option value="">All statuses</option>{BOOKING_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Booked from (UTC)<input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} /></label>
      <label>Booked to (UTC)<input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} /></label>
      <button type="submit" className="admin-btn">Apply filters</button>
      <button type="button" className="admin-btn" onClick={() => { const empty = { reference: '', supplier: '', status: '', from: '', to: '' }; setDraft(empty); setFilters(empty); setPage(1) }}>Clear</button>
    </form>
    <OpsState state={bookings.state} onRetry={bookings.reload}>
      {data => <>
        {data.items.length === 0 ? <p role="status">No reservations match these hotel filters.</p> : <ScrollRegion label="Hotel reservations"><table style={tableStyle} aria-label="All reservations for selected hotel"><thead><tr>{['Reference', 'Guest', 'Supplier', 'Room type / rate plan', 'Check-in', 'Check-out', 'Room nights', 'Amount', 'Status', 'Booked'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead><tbody>{data.items.map(b => <tr key={b.id}>
          <td style={td}><Link href={`/bookings/${b.id}`}>{b.reference}</Link></td><td style={td}>{b.leadGuest?.name ?? 'Not recorded'}</td><td style={td}>{b.supplier}{b.supplierRef && <div>{b.supplierRef}</div>}</td><td style={td}>{b.room?.name ?? 'Not recorded'}<div><code>{b.ratePlanId ?? 'Rate plan not recorded'}</code></div></td><td style={td}>{b.checkIn ?? 'Unknown'}</td><td style={td}>{b.checkOut ?? 'Unknown'}</td><td style={td}>{b.roomNights ?? 'Unknown'}</td><td style={td}><Money minor={b.sellMinor} currency={b.currency} /></td><td style={td}><Tag tone={bookingTone(b.status)}>{b.status.replace(/_/g, ' ')}</Tag></td><td style={td}>{when(b.createdAt)}</td>
        </tr>)}</tbody></table></ScrollRegion>}
        <nav aria-label="Hotel reservation pagination" style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}><button type="button" className="admin-btn" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {data.page} · {data.total} reservations</span><button type="button" className="admin-btn" disabled={page * data.pageSize >= data.total} onClick={() => setPage(p => p + 1)}>Next</button></nav>
      </>}
    </OpsState>
  </section>
}
