'use client'

import { useState } from 'react'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import type { SearchCriteria, SearchHotelOffer, SearchRateOffer, SearchRoomOffer } from '@bedbanks/domain'
import { ApiHotelService } from '@/services/hotel-service'
import { Bell, CalendarDays, CheckCircle2, CircleHelp, FileText, LayoutDashboard, MapPin, Menu, Search, ShieldAlert, SlidersHorizontal, WalletCards, X } from 'lucide-react'
import type { AgentIdentity } from '@/lib/api-client'
import type { Hotel, HotelSearchResult } from '@/types/hotel'

type View = 'dashboard' | 'search' | 'bookings' | 'wallet'

export function AgentPortal({ identity, tenantId, providerStatus, finance }: { identity: AgentIdentity; tenantId: string; providerStatus: 'idle' | 'checking' | 'available' | 'unavailable'; finance: { status: string; availableCredit: number | null } | null }) {
  const [view, setView] = useState<View>('dashboard')
  const [mobileNav, setMobileNav] = useState(false)
  const [destination, setDestination] = useState('Dubai')
  const [checkIn, setCheckIn] = useState(() => new Date().toISOString().slice(0, 10))
  const [checkOut, setCheckOut] = useState(() => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10))
  const [rooms, setRooms] = useState(1)
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [childAges, setChildAges] = useState<number[]>([])
  const guests = `${rooms} room${rooms === 1 ? '' : 's'} · ${adults} adult${adults === 1 ? '' : 's'}${children ? ` · ${children} children` : ''}`
  const [selected, setSelected] = useState<Hotel | null>(null)
  const [searchResult, setSearchResult] = useState<HotelSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [toast, setToast] = useState('')
  const [filter, setFilter] = useState('All')
  const agency = identity.memberships.find((membership) => membership.tenantId === tenantId)?.tenantName ?? 'Verified agency workspace'
  const creditLabel = finance?.availableCredit == null ? 'Not configured' : `USD ${finance.availableCredit.toLocaleString()}`
  const show = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2200) }
  const nav = (next: View) => { setView(next); setMobileNav(false); setSelected(null) }
  const criteria: SearchCriteria = { destination: destination.trim(), checkIn, checkOut, rooms, adults, children, childAges, nationality: 'IN', currency: 'AED' }
  const updateChildren = (count: number) => { setChildren(count); setChildAges((ages) => Array.from({ length: count }, (_, index) => ages[index] ?? 0)) }
  async function handleSearch() {
    if (searching) return
    setSelected(null)
    setSearchResult(null)
    if (!validSearchCriteria(criteria)) {
      show('Enter a destination, valid dates and occupancy')
      return
    }
    setSearching(true)
    try {
      setSearchResult(await new ApiHotelService().search(criteria, tenantId))
    } finally {
      setSearching(false)
    }
  }

  return <div className="portal-shell">
    <header className="portal-header"><button className="portal-mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Open navigation"><Menu size={20} /></button><button className="portal-brand" onClick={() => nav('dashboard')}><span>f</span><strong>fBeds</strong><small>WHOLESALE TRAVEL</small></button><div className="portal-global-search"><Search size={16} /><input placeholder="Search hotels, bookings or guests" aria-label="Global search" onKeyDown={(event) => event.key === 'Enter' && nav('search')} /><kbd>⌘ K</kbd></div><div className="portal-header-actions"><span className={`portal-live ${searchResult?.status === 'available' ? 'is-live' : ''}`}><i /> {searchResult?.status === 'available' ? 'VERIFIED LIVE OFFERS' : providerStatus === 'checking' ? 'VERIFYING WORKSPACE' : providerStatus === 'unavailable' ? 'INVENTORY UNAVAILABLE' : 'SUPPLIER NOT CHECKED'}</span><span className="portal-credit">Credit <strong>{creditLabel}</strong></span><button onClick={() => show('No new notifications')} aria-label="Notifications"><Bell size={17} /></button><button onClick={() => show('Support is available from your account team')} aria-label="Support"><CircleHelp size={17} /></button><span className="portal-avatar">{(identity.user.name ?? 'JD').slice(0, 2).toUpperCase()}</span></div></header>
    <div className="portal-body"><aside className={`portal-sidebar ${mobileNav ? 'is-open' : ''}`}><div className="portal-sidebar-heading">WORKSPACE <button onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={16} /></button></div><nav aria-label="Agent portal navigation"><NavItem icon={<LayoutDashboard size={17} />} label="Dashboard" active={view === 'dashboard'} onClick={() => nav('dashboard')} /><NavItem icon={<Search size={17} />} label="Hotel search" active={view === 'search'} onClick={() => nav('search')} /><NavItem icon={<FileText size={17} />} label="My bookings" active={view === 'bookings'} onClick={() => nav('bookings')} /><NavItem icon={<WalletCards size={17} />} label="Wallet & credit" active={view === 'wallet'} onClick={() => nav('wallet')} /></nav><div className="portal-sidebar-footer"><span className="portal-eyebrow">ACTIVE AGENCY</span><strong>{agency}</strong><small>{identity.user.email}</small></div></aside><main className="portal-main"><div className="portal-breadcrumb">fBeds Agent Portal <span>/</span> {view === 'dashboard' ? 'Dashboard' : view === 'search' ? 'Hotel search' : view === 'bookings' ? 'My bookings' : 'Wallet & credit'}</div>{view === 'dashboard' && <Dashboard onSearch={() => nav('search')} onBookings={() => nav('bookings')} agency={agency} userName={identity.user.name ?? identity.user.email} creditLabel={creditLabel} hasFinance={finance?.availableCredit != null} demoEnabled={process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production'} show={show} />}{view === 'search' && <SearchView destination={destination} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut} guests={guests} hotels={searchResult?.hotels ?? []} liveHotels={searchResult?.liveHotels ?? []} result={searchResult} rooms={rooms} setRooms={setRooms} adults={adults} setAdults={setAdults} children={children} updateChildren={updateChildren} childAges={childAges} setChildAges={setChildAges} searching={searching} onSearch={handleSearch} selected={selected} setSelected={setSelected} onCriteriaChange={() => { setSearchResult(null); setSelected(null) }} />}{view === 'bookings' && <Bookings demoEnabled={process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production'} filter={filter} setFilter={setFilter} onSearch={() => nav('search')} />}{view === 'wallet' && <Wallet creditLabel={creditLabel} hasFinance={finance?.availableCredit != null} show={show} />}</main></div>{toast && <div className="portal-toast" role="status"><CheckCircle2 size={16} /> {toast}</div>}</div>
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) { return <button className={`portal-nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{active && <b />}</button> }

function Dashboard({ onSearch, onBookings, agency, userName, creditLabel, hasFinance, demoEnabled, show }: { onSearch: () => void; onBookings: () => void; agency: string; userName: string; creditLabel: string; hasFinance: boolean; demoEnabled: boolean; show: (message: string) => void }) { return <><section className="portal-heading-row"><div><span className="portal-eyebrow">OPERATIONAL OVERVIEW</span><h1>Good morning, {userName.split(' ')[0]}</h1><p>{agency} · Verified workspace</p></div><button className="portal-primary" onClick={onSearch}><Search size={16} /> Search hotels</button></section>{demoEnabled && <div className="portal-notice"><ShieldAlert size={17} /><div><strong>Demo inventory mode</strong><span>Supplier connectivity is not configured for this workspace. Search results below are clearly labelled sample data and cannot be booked.</span></div><button onClick={() => show('Connect a supplier in the platform environment to enable live rates')}>Learn more</button></div>}<section className="portal-kpis"><Kpi label="Available credit" value={creditLabel} tone={hasFinance ? 'green' : undefined} /><Kpi label="Used credit" value="Not connected" /><Kpi label="Confirmed bookings" value={demoEnabled ? "Sample only" : "Unavailable"} /><Kpi label="Cancellation alerts" value={demoEnabled ? "Sample only" : "Unavailable"} tone="amber" /></section><section className="portal-dashboard-grid"><div className="portal-panel portal-fast-search"><div className="portal-panel-heading"><div><span className="portal-eyebrow">FAST HOTEL SEARCH</span><h2>Find the right rate for your client</h2></div><SlidersHorizontal size={18} /></div><SearchForm compact onSubmit={onSearch} /></div><div className="portal-panel"><div className="portal-panel-heading"><div><span className="portal-eyebrow">RECENT ACTIVITY</span><h2>Upcoming bookings</h2></div><button className="portal-link" onClick={onBookings}>View all</button></div>{demoEnabled ? <BookingRows /> : <div className="portal-empty">Booking history is unavailable until the booking API is connected.</div>}</div></section></> }
function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) { return <div className="portal-kpi"><span>{label}</span><strong className={tone ?? ''}>{value}</strong><small>{tone === 'amber' ? 'Needs attention' : 'vs. previous period'}</small></div> }
function SearchForm({ compact, onSubmit }: { compact?: boolean; onSubmit: () => void }) { return <div className={`portal-search-form ${compact ? 'compact' : ''}`}><label className="portal-field wide"><span>DESTINATION, HOTEL OR LANDMARK</span><div><MapPin size={16} /><input value="Dubai" readOnly aria-label="Destination" /></div></label><label className="portal-field"><span>CHECK-IN</span><div><CalendarDays size={15} /><input value="Set dates in Hotel search" readOnly aria-label="Check-in" /></div></label><label className="portal-field"><span>CHECK-OUT</span><div><CalendarDays size={15} /><input value="Set dates in Hotel search" readOnly aria-label="Check-out" /></div></label><label className="portal-field"><span>ROOMS & GUESTS</span><div><input value="1 room · 2 adults" readOnly aria-label="Rooms and guests" /></div></label><button className="portal-primary search-submit" onClick={onSubmit}><Search size={16} /> Search</button></div> }
function SearchView({
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  guests, hotels, liveHotels, result, searching, onSearch, selected, setSelected,
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges, onCriteriaChange,
}: {
  destination: string; setDestination: (value: string) => void
  checkIn: string; setCheckIn: (value: string) => void
  checkOut: string; setCheckOut: (value: string) => void
  guests: string; hotels: Hotel[]; liveHotels: SearchHotelOffer[]
  result: HotelSearchResult | null; searching: boolean; onSearch: () => void
  selected: Hotel | null; setSelected: (value: Hotel | null) => void
  rooms: number; setRooms: (value: number) => void
  adults: number; setAdults: (value: number) => void
  children: number; updateChildren: (value: number) => void
  childAges: number[]; setChildAges: (value: number[]) => void
  onCriteriaChange: () => void
}) {
  const [selectedLive, setSelectedLive] = useState<SearchHotelOffer | null>(null)
  const update = (action: () => void) => { onCriteriaChange(); setSelectedLive(null); action() }
  return <>
    <section className="portal-heading-row"><div><span className="portal-eyebrow">HOTEL SEARCH</span><h1>Search hotels</h1><p>Compare verified rooms, board basis and total stay rates.</p></div></section>
    <div className="portal-panel portal-search-panel"><div className="portal-search-form">
      <label className="portal-field wide"><span>DESTINATION</span><div><MapPin size={16} /><input value={destination} onChange={(event) => update(() => setDestination(event.target.value))} aria-label="Destination" /></div></label>
      <label className="portal-field"><span>CHECK-IN</span><div><CalendarDays size={15} /><input type="date" value={checkIn} onChange={(event) => update(() => setCheckIn(event.target.value))} aria-label="Check-in" /></div></label>
      <label className="portal-field"><span>CHECK-OUT</span><div><CalendarDays size={15} /><input type="date" value={checkOut} onChange={(event) => update(() => setCheckOut(event.target.value))} aria-label="Check-out" /></div></label>
      <label className="portal-field"><span>ROOMS</span><div><input type="number" min={1} max={20} value={rooms} onChange={(event) => update(() => setRooms(Number(event.target.value)))} aria-label="Rooms" /></div></label>
      <label className="portal-field"><span>ADULTS</span><div><input type="number" min={1} max={40} value={adults} onChange={(event) => update(() => setAdults(Number(event.target.value)))} aria-label="Adults" /></div></label>
      <label className="portal-field"><span>CHILDREN</span><div><input type="number" min={0} max={40} value={children} onChange={(event) => update(() => updateChildren(Number(event.target.value)))} aria-label="Children" /></div></label>
      {childAges.map((age, index) => <label className="portal-field" key={index}><span>CHILD {index + 1} AGE</span><div><input type="number" min={0} max={17} value={age} onChange={(event) => update(() => setChildAges(childAges.map((value, position) => position === index ? Number(event.target.value) : value)))} aria-label={`Child ${index + 1} age`} /></div></label>)}
      <button className="portal-primary search-submit" onClick={() => { setSelectedLive(null); onSearch() }} disabled={searching}><Search size={16} /> {searching ? 'Searching…' : 'Search'}</button>
    </div><p>Nationality: IN · Currency: AED. Search uses the dates and occupancy shown above.</p></div>
    {result && <><div className="portal-results-meta"><div><strong>{result.total}</strong> properties in <strong>{result.request.destination}</strong><small>{result.request.checkIn} — {result.request.checkOut} · {guests} · {result.request.currency}</small></div></div>
      <div className="portal-demo-label" role="status"><ShieldAlert size={15} /> {result.status === 'demo' ? 'Sample inventory only. Amounts are illustrative; booking is disabled.' :
        result.status === 'available' ? 'Verified supplier offers. Rate recheck and booking are unavailable.' :
        result.status === 'mapping_unavailable' ? 'Supplier offer mapping could not be verified. No rate is displayed.' :
        result.status === 'access_denied' ? 'You do not have access to this workspace.' :
        result.status === 'auth_required' ? 'Your session expired. Sign in again.' :
        result.status === 'empty' ? 'No availability for this search.' :
        'Supplier inventory is unavailable. Booking is disabled.'}</div>
      {selectedLive ? <LiveHotelDetail key={selectedLive.hotelId} hotel={selectedLive} request={result.request} onBack={() => setSelectedLive(null)} /> :
        selected ? <HotelDetail hotel={selected} onBack={() => setSelected(null)} /> :
        <div className="portal-results-layout"><div className="portal-hotel-list">
          {liveHotels.map((hotel) => <LiveHotelCard key={hotel.hotelId} hotel={hotel} onSelect={() => setSelectedLive(hotel)} />)}
          {hotels.map((hotel) => <HotelCard key={hotel.id} hotel={hotel} onSelect={() => setSelected(hotel)} />)}
          {!hotels.length && !liveHotels.length && <div className="portal-empty"><Search size={20} /><h2>No available offers</h2><p>Change the search or try again later.</p></div>}
        </div></div>}</>}
  </>
}

function formatTotal(total: SearchRateOffer['total']) {
  // Format the supplied minor-unit amount without changing the commercial total.
  const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: total.currency })
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
  const scale = BigInt(10 ** digits)
  const amount = BigInt(total.amountMinor)
  const whole = new Intl.NumberFormat('en-US').format(amount / scale)
  const fraction = String(amount % scale).padStart(digits, '0')
  return formatter.formatToParts(0).map((part) =>
    part.type === 'integer' ? whole : part.type === 'fraction' ? fraction : part.type === 'group' ? '' : part.value,
  ).join('')
}
function LiveHotelCard({ hotel, onSelect }: { hotel: SearchHotelOffer; onSelect: () => void }) {
  const firstRate = hotel.rooms.flatMap((room) => room.rates).find((rate) => rate.availability !== 'sold_out')
  return <article className="portal-hotel-card"><div className="portal-hotel-content"><h2>{hotel.name}</h2><p><MapPin size={14} /> {hotel.destination}</p><div className="portal-hotel-bottom"><div><small>AUTHORITATIVE TOTAL STAY PRICE</small><strong>{firstRate ? formatTotal(firstRate.total) : 'No available rate'}</strong><span>Rate recheck and booking unavailable</span></div><button className="portal-secondary" onClick={onSelect}>View verified rooms & rates</button></div></div></article>
}
function LiveHotelDetail({ hotel, request, onBack }: { hotel: SearchHotelOffer; request: SearchCriteria; onBack: () => void }) {
  const [selection, setSelection] = useState<{ hotel: SearchHotelOffer; room: SearchRoomOffer; rate: SearchRateOffer; searchContext: SearchCriteria } | null>(null)
  return <section className="portal-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button><div className="portal-detail-header"><div><span className="portal-eyebrow">VERIFIED SUPPLIER OFFERS</span><h2>{hotel.name}</h2><p>{hotel.destination}</p></div></div>
    {hotel.rooms.map((room) => <div className="portal-room" key={room.roomTypeId}><div><span className="portal-eyebrow">ROOM TYPE</span><h3>{room.name}</h3></div><div className="portal-rate">{room.rates.map((rate) => {
      const expired = Date.parse(rate.expiresAt) <= Date.now()
      const selectable = !expired && rate.availability !== 'sold_out'
      return <div key={rate.offerId}><span className="portal-eyebrow">RATE PLAN · BOARD BASIS</span><strong>{rate.ratePlanName} · {rate.boardBasisName}</strong><span>{rate.cancellation.summary} · {rate.availability.replace('_', ' ')}</span><b>{formatTotal(rate.total)} total stay</b><button className="portal-secondary" disabled={!selectable} onClick={() => { if (Date.parse(rate.expiresAt) > Date.now() && rate.availability !== 'sold_out') setSelection({ hotel, room, rate, searchContext: request }) }}>{expired ? 'Rate expired' : rate.availability === 'sold_out' ? 'Unavailable' : 'Select rate for review'}</button></div>
    })}</div></div>)}
    {selection && <div className="portal-policy-note" role="status"><ShieldAlert size={16} /><span>Selected: {selection.room.name} · {selection.rate.ratePlanName} · {selection.rate.boardBasisName} · {formatTotal(selection.rate.total)}. Authoritative recheck is unavailable; booking cannot proceed.</span><button disabled>Booking unavailable</button></div>}
  </section>
}
function HotelCard({ hotel, onSelect }: { hotel: Hotel; onSelect: () => void }) { return <article className="portal-hotel-card"><img src={hotel.image} alt={`${hotel.name} exterior`} /><div className="portal-hotel-content"><div className="portal-hotel-title"><div><h2>{hotel.name}</h2><span className="portal-stars">{'★'.repeat(hotel.stars)}</span><p><MapPin size={14} /> {hotel.city} · {hotel.distance}</p></div><span className="portal-score">{hotel.rating.toFixed(1)}<small>/5</small></span></div><div className="portal-hotel-tags"><span>{hotel.board}</span><span className="success">{hotel.cancellation}</span></div><div className="portal-hotel-bottom"><div><small>ILLUSTRATIVE SAMPLE AMOUNT · NOT BOOKABLE</small><strong>AED {hotel.price.toLocaleString()}</strong></div><button className="portal-secondary" onClick={onSelect}>View sample details</button></div></div></article> }
function HotelDetail({ hotel, onBack }: { hotel: Hotel; onBack: () => void }) { return <section className="portal-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button><div className="portal-detail-header"><div><span className="portal-eyebrow">SAMPLE PROPERTY · NOT BOOKABLE</span><h2>{hotel.name}</h2><p><MapPin size={14} /> {hotel.city}</p></div></div><div className="portal-policy-note"><ShieldAlert size={16} /> No authoritative room, rate or policy is available for this sample property. Booking is disabled.</div></section> }
function BookingRows({ filter = 'All' }: { filter?: string }) {
  const rows = [
    ['FB-10482', 'One&Only Royal Mirage', '15 Sep · 2 guests', 'Confirmed', 'status-confirmed'],
    ['FB-10479', 'Palace Downtown', '22 Sep · 1 guest', 'Pending', 'status-pending'],
    ['FB-10471', 'Nikki Beach Resort', '28 Sep · 2 guests', 'Confirmed', 'status-confirmed'],
  ].filter((row) => filter === 'All' || row[3] === filter)
  return <div className="portal-booking-list">{rows.map(([id, hotel, details, status, statusClass]) => <div key={id}><span>{id}</span><strong>{hotel}</strong><small>{details}</small><b className={statusClass}>{status}</b></div>)}{rows.length === 0 && <div className="portal-empty"><strong>No sample bookings in this filter</strong></div>}</div>
}
function Bookings({ demoEnabled, filter, setFilter, onSearch }: { demoEnabled: boolean; filter: string; setFilter: (v: string) => void; onSearch: () => void }) { if (!demoEnabled) return <section className="portal-empty"><h1>My bookings</h1><p>Booking history is unavailable until the transactional API is connected.</p><button className="portal-primary" onClick={onSearch}>New search</button></section>; return <><section className="portal-heading-row"><div><span className="portal-eyebrow">BOOKING OPERATIONS · SAMPLE DATA</span><h1>My bookings</h1><p>Track confirmed, pending and cancelled agency reservations.</p></div><button className="portal-primary" onClick={onSearch}><Search size={16} /> New search</button></section><div className="portal-demo-label"><ShieldAlert size={14} /> These bookings are sample records. Live booking history will appear after the supplier and booking APIs are connected.</div><div className="portal-panel"><div className="portal-tabs">{['All', 'Confirmed', 'Pending', 'Cancelled'].map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="portal-table-wrap"><table><thead><tr><th>Booking ID</th><th>Hotel</th><th>Traveller</th><th>Check-in</th><th>Status</th><th>Total</th><th /></tr></thead><tbody>{[
  ['FB-10482', 'One&Only Royal Mirage', 'Priya Sharma', '15 Sep 2026', 'Confirmed', 'AED 2,460', 'status-confirmed'],
  ['FB-10479', 'Palace Downtown', 'Oliver Smith', '22 Sep 2026', 'Pending', 'AED 1,980', 'status-pending'],
].filter((row) => filter === 'All' || row[4] === filter).map(([id, hotel, traveller, date, status, total, statusClass]) => <tr key={id}><td><strong>{id}</strong></td><td>{hotel}<br /><small>Dubai</small></td><td>{traveller}</td><td>{date}</td><td><span className={statusClass}>{status}</span></td><td>{total}</td><td><button className="portal-link" disabled title="Live booking details are not connected">Unavailable</button></td></tr>)}{filter === 'Cancelled' && <tr><td colSpan={7}><div className="portal-empty"><strong>No sample cancelled bookings</strong></div></td></tr>}</tbody></table></div></div></> }
function Wallet({ creditLabel, hasFinance, show }: { creditLabel: string; hasFinance: boolean; show: (message: string) => void }) { return <><section className="portal-heading-row"><div><span className="portal-eyebrow">COMMERCIAL CONTROLS</span><h1>Wallet & credit</h1><p>Monitor your agency credit exposure and booking deductions.</p></div><button className="portal-secondary" onClick={() => show(hasFinance ? 'Statement export will be available when ledger detail is enabled' : 'Statements are unavailable until finance is configured')}><FileText size={16} /> Download statement</button></section><div className="portal-kpis"><Kpi label="Available credit" value={creditLabel} tone={hasFinance ? 'green' : undefined} /><Kpi label="Credit limit" value="Not connected" /><Kpi label="Used credit" value="Not connected" /><Kpi label="Outstanding" value="Not connected" /></div><div className="portal-panel portal-unavailable-panel"><ShieldAlert size={22} /><div><span className="portal-eyebrow">FINANCE API STATUS</span><h2>{hasFinance ? 'Ledger detail is not connected' : 'Finance API is not configured'}</h2><p>{hasFinance ? 'The current credit summary is live. Detailed transaction history, statements and credit deductions will appear once ledger detail is enabled.' : 'Credit balance, statements and booking deductions will appear once finance is configured for this workspace.'}</p></div></div></> }
