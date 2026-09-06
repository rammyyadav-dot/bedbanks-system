'use client'

import { useMemo, useState } from 'react'
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  Hotel,
  LayoutDashboard,
  MapPin,
  Menu,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  Users,
  WalletCards,
  X,
} from 'lucide-react'

const hotels = [
  { id: 'HTL-000182', name: 'Jumeirah Beach Hotel', city: 'Dubai, UAE', stars: 5, rating: 4.9, price: 820, rooms: 12, supplier: 'Hotelbeds', board: 'Breakfast included', image: 'bg-[#5b9da4]' },
  { id: 'HTL-000241', name: 'The St. Regis Abu Dhabi', city: 'Abu Dhabi, UAE', stars: 5, rating: 4.8, price: 690, rooms: 8, supplier: 'WebBeds', board: 'Room only', image: 'bg-[#7185a9]' },
  { id: 'HTL-000319', name: 'Waldorf Astoria Ras Al Khaimah', city: 'Ras Al Khaimah, UAE', stars: 5, rating: 4.7, price: 540, rooms: 6, supplier: 'Direct', board: 'Half board', image: 'bg-[#b18b63]' },
  { id: 'HTL-000401', name: 'Address Sky View', city: 'Dubai, UAE', stars: 5, rating: 4.9, price: 760, rooms: 14, supplier: 'Hotelbeds', board: 'Bed & breakfast', image: 'bg-[#6b8790]' },
]

const bookings = [
  ['UWB-48291', 'Jumeirah Beach Hotel', 'M. Al Mansoori', '18 Sep — 21 Sep 2026', 'Confirmed', 'AED 2,460'],
  ['UWB-48276', 'The St. Regis Abu Dhabi', 'S. Rahman', '22 Sep — 25 Sep 2026', 'On request', 'AED 2,070'],
  ['UWB-48198', 'Waldorf Astoria RAK', 'A. Patel', '03 Oct — 07 Oct 2026', 'Confirmed', 'AED 2,160'],
]

export function AgentPortal() {
  const [query, setQuery] = useState('Dubai')
  const [active, setActive] = useState('Search')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selected, setSelected] = useState<typeof hotels[number] | null>(null)
  const [toast, setToast] = useState('')
  const [mobileNav, setMobileNav] = useState(false)
  const [stars, setStars] = useState(0)
  const [instant, setInstant] = useState(false)

  const results = useMemo(() => hotels.filter((hotel) => {
    const matchesQuery = !query || `${hotel.name} ${hotel.city}`.toLowerCase().includes(query.toLowerCase())
    const matchesStars = !stars || hotel.stars >= stars
    const matchesInstant = !instant || hotel.rooms >= 8
    return matchesQuery && matchesStars && matchesInstant
  }), [query, stars, instant])

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600) }

  return <div className="enterprise-shell">
    <aside className={`enterprise-sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <div className="enterprise-brand"><span className="enterprise-mark"><Hotel size={17} /></span><span><strong>atlas</strong><small>WHOLESALE TRAVEL</small></span><button className="sidebar-close" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={17} /></button></div>
      <div className="context-switcher"><button className="context-button"><span className="context-avatar">A</span><span><small>AGENCY WORKSPACE</small><strong>Atlas Getaways</strong></span><ChevronDown size={14} /></button></div>
      <span className="shell-caption">OPERATIONS</span>
      <nav className="enterprise-nav">{[['Dashboard', LayoutDashboard], ['Search hotels', Search], ['Bookings', CalendarDays], ['Clients', Users]].map(([label, Icon]) => <button key={label as string} className={active === label ? 'active' : ''} onClick={() => { setActive(label as string); setMobileNav(false) }}><Icon size={16} /><span>{label as string}</span>{label === 'Bookings' && <em>12</em>}</button>)}</nav>
      <span className="shell-caption platform-caption">PLATFORM</span>
      <nav className="enterprise-nav"><button onClick={() => notify('Settings opened')}><Settings size={16} /><span>Settings</span></button><button onClick={() => notify('Support center opened')}><CircleHelp size={16} /><span>Support center</span></button></nav>
      <div className="portal-sidebar-bottom"><div className="portal-credit"><WalletCards size={15} /><span>Available credit<strong>AED 184,290</strong></span></div><div className="portal-user"><span>JD</span><div><strong>Jordan Davis</strong><small>Administrator</small></div><ChevronDown size={14} /></div></div>
    </aside>
    <main className="enterprise-main">
      <header className="enterprise-header"><button className="portal-mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation"><Menu size={19} /></button><div className="portal-breadcrumb"><span>Atlas Getaways</span><b>/</b><strong>{active}</strong></div><div className="portal-header-actions"><span className="portal-live"><i /> LIVE INVENTORY</span><button className="portal-icon" onClick={() => notify('You have 3 new notifications')} aria-label="Notifications"><Bell size={17} /><i /></button><span className="portal-avatar">JD</span></div></header>
      <div className="portal-content">
        <section className="portal-heading"><div><span className="portal-eyebrow">ATLAS GETAWAYS · AGT-093</span><h1>Find your next stay.</h1><p>Search live wholesale availability with net rates and instant confirmation.</p></div><button className="portal-outline" onClick={() => notify('Help center opened')}><CircleHelp size={15} /> Need help?</button></section>
        <section className="portal-search-card"><div className="portal-card-heading"><div><span className="portal-eyebrow teal">LIVE INVENTORY <i /> CONNECTED</span><h2>Search hotels</h2></div><button className="portal-filter-button" onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={15} /> Filters <ChevronDown size={13} /></button></div><div className="portal-search-grid"><label className="portal-field destination"><span>DESTINATION, HOTEL OR GIATA</span><div><MapPin size={15} /><input aria-label="Destination" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="City, hotel or GIATA code" /></div></label><label className="portal-field"><span>CHECK-IN</span><div><CalendarDays size={15} /><input aria-label="Check-in" value="18 Sep 2026" readOnly /></div></label><label className="portal-field"><span>CHECK-OUT</span><div><CalendarDays size={15} /><input aria-label="Check-out" value="21 Sep 2026" readOnly /></div></label><label className="portal-field"><span>ROOMS & GUESTS</span><div><Users size={15} /><input aria-label="Guests" value="1 room · 2 guests" readOnly /></div></label><button className="portal-search-submit" onClick={() => notify(`${results.length * 24} properties found`)}><Search size={16} /> Search</button></div>{filtersOpen && <div className="portal-filters"><button className={stars === 5 ? 'selected' : ''} onClick={() => setStars(stars === 5 ? 0 : 5)}><Star size={13} /> 5 stars</button><button className={instant ? 'selected' : ''} onClick={() => setInstant(!instant)}><Check size={13} /> 8+ rooms available</button><button onClick={() => { setStars(0); setInstant(false) }}>Clear filters</button></div>}<div className="portal-search-meta"><span>{results.length * 24} properties available</span><span>All rates in AED · net rates · per night</span></div></section>
        <section className="portal-section"><div className="portal-section-heading"><div><span className="portal-eyebrow">RECOMMENDED INVENTORY</span><h2>Hotels in {query || 'all destinations'}</h2></div><button className="portal-link" onClick={() => notify('Showing all hotel results')}>View all results <ArrowRight size={14} /></button></div><div className="portal-toolbar"><span><strong>{results.length * 24}</strong> available properties · <strong>4</strong> suppliers connected</span><button onClick={() => notify('Sort options opened')}>Sort: Recommended <ChevronDown size={13} /></button></div><div className="portal-hotel-grid">{results.length ? results.map((hotel) => <article className="portal-hotel-card" key={hotel.id}><div className={`portal-hotel-image ${hotel.image}`}><span>{hotel.rooms > 8 ? 'Instant confirm' : 'Limited rooms'}</span><strong>{hotel.name[0]}</strong><small>{hotel.id}</small></div><div className="portal-hotel-body"><div className="portal-hotel-title"><div><h3>{hotel.name}</h3><p><MapPin size={11} /> {hotel.city}</p><div className="portal-rating">{Array.from({ length: hotel.stars }).map((_, i) => <Star key={i} size={11} fill="currentColor" />)} <b>{hotel.rating}</b><span>·</span>{hotel.board}</div></div><span className="portal-confirmed"><Check size={13} /></span></div><div className="portal-supplier"><span>{hotel.supplier}</span><span>{hotel.rooms} rooms left</span></div><div className="portal-hotel-footer"><span>From <strong>AED {hotel.price}</strong> <small>/ night</small></span><button onClick={() => setSelected(hotel)}>View availability <ArrowRight size={13} /></button></div></div></article>) : <div className="portal-empty"><Search size={20} /><strong>No properties found</strong><span>Try searching Dubai, Abu Dhabi or Ras Al Khaimah.</span></div>}</div></section>
        <section className="portal-section portal-bookings"><div className="portal-section-heading"><div><span className="portal-eyebrow">RESERVATION DESK</span><h2>Recent bookings</h2></div><button className="portal-link" onClick={() => setActive('Bookings')}>Manage bookings <ArrowRight size={14} /></button></div><div className="portal-bookings-table"><div className="portal-bookings-head"><span>REFERENCE</span><span>PROPERTY / GUEST</span><span>STAY DATES</span><span>STATUS</span><span>AMOUNT</span><span /></div>{bookings.map(([ref, hotel, guest, dates, status, amount]) => <div className="portal-booking-row" key={ref}><b>{ref}</b><span><strong>{hotel}</strong><small>{guest}</small></span><span>{dates}</span><em className={status === 'Confirmed' ? 'confirmed' : 'request'}>{status}</em><strong>{amount}</strong><button onClick={() => notify(`Voucher ${ref} downloaded`)} aria-label={`Download voucher for ${ref}`}><Download size={14} /></button></div>)}</div></section>
      </div>
    </main>
    {selected && <div className="portal-modal-backdrop" onClick={() => setSelected(null)}><div className="portal-modal" onClick={(e) => e.stopPropagation()}><button className="portal-modal-close" onClick={() => setSelected(null)} aria-label="Close"><X size={17} /></button><span className="portal-eyebrow teal">HOTEL DETAILS · {selected.id}</span><h2>{selected.name}</h2><p><MapPin size={13} /> {selected.city} · <Star size={12} fill="currentColor" /> {selected.rating}</p><div className="portal-room-option"><div><strong>Deluxe King Room</strong><small>{selected.board} · Free cancellation</small></div><b>AED {selected.price}<small>/ night</small></b></div><div className="portal-room-option"><div><strong>Executive Suite</strong><small>Breakfast included · Sea view</small></div><b>AED {selected.price + 220}<small>/ night</small></b></div><button className="portal-search-submit full" onClick={() => { setSelected(null); notify('Room selected — booking flow opened') }}>Continue to booking <ArrowRight size={15} /></button></div></div>}
    {toast && <div className="portal-toast">{toast}</div>}
  </div>
}
