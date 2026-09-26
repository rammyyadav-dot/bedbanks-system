'use client'

import { Search, ShieldAlert } from 'lucide-react'

export function BookingRows({ filter = 'All' }: { filter?: string }) {
  const rows = [
    ['FB-10482', 'One&Only Royal Mirage', '15 Sep · 2 guests', 'Confirmed', 'status-confirmed'],
    ['FB-10479', 'Palace Downtown', '22 Sep · 1 guest', 'Pending', 'status-pending'],
    ['FB-10471', 'Nikki Beach Resort', '28 Sep · 2 guests', 'Confirmed', 'status-confirmed'],
  ].filter((row) => filter === 'All' || row[3] === filter)
  return <div className="portal-booking-list">{rows.map(([id, hotel, details, status, statusClass]) => <div key={id}><span>{id}</span><strong>{hotel}</strong><small>{details}</small><b className={statusClass}>{status}</b></div>)}{rows.length === 0 && <div className="portal-empty"><strong>No sample bookings in this filter</strong></div>}</div>
}
export function Bookings({ demoEnabled, filter, setFilter, onSearch }: { demoEnabled: boolean; filter: string; setFilter: (v: string) => void; onSearch: () => void }) { if (!demoEnabled) return <section className="portal-empty"><h1>My bookings</h1><p>Booking history is unavailable until the transactional API is connected.</p><button className="portal-primary" onClick={onSearch}>New search</button></section>; return <><section className="portal-heading-row"><div><span className="portal-eyebrow">BOOKING OPERATIONS · SAMPLE DATA</span><h1>My bookings</h1><p>Track confirmed, pending and cancelled agency reservations.</p></div><button className="portal-primary" onClick={onSearch}><Search size={16} /> New search</button></section><div className="portal-demo-label"><ShieldAlert size={14} /> These bookings are sample records. Live booking history will appear after the supplier and booking APIs are connected.</div><div className="portal-panel"><div className="portal-tabs" role="tablist" aria-label="Booking status filters">{['All', 'Confirmed', 'Pending', 'Cancelled'].map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="portal-table-wrap"><table><thead><tr><th>Booking ID</th><th>Hotel</th><th>Traveller</th><th>Check-in</th><th>Status</th><th>Total</th><th /></tr></thead><tbody>{[
  ['FB-10482', 'One&Only Royal Mirage', 'Priya Sharma', '15 Sep 2026', 'Confirmed', 'AED 2,460', 'status-confirmed'],
  ['FB-10479', 'Palace Downtown', 'Oliver Smith', '22 Sep 2026', 'Pending', 'AED 1,980', 'status-pending'],
].filter((row) => filter === 'All' || row[4] === filter).map(([id, hotel, traveller, date, status, total, statusClass]) => <tr key={id}><td><strong>{id}</strong></td><td>{hotel}<br /><small>Dubai</small></td><td>{traveller}</td><td>{date}</td><td><span className={statusClass}>{status}</span></td><td>{total}</td><td><button className="portal-link" disabled title="Live booking details are not connected">Unavailable</button></td></tr>)}{filter === 'Cancelled' && <tr><td colSpan={7}><div className="portal-empty"><strong>No sample cancelled bookings</strong></div></td></tr>}</tbody></table></div></div></> }
