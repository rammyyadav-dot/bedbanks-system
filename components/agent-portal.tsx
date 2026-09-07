'use client'

import { useMemo, useState } from 'react'
import {
  Bell, CalendarDays, Check, ChevronDown, CircleHelp, Filter, MapPin,
  Search, SlidersHorizontal, Star, Users, X,
} from 'lucide-react'

const hotels = [
  { id: 'HTL-000182', name: 'Jumeirah Beach Hotel', city: 'Dubai, United Arab Emirates', stars: 5, rating: 4.9, price: 820, rooms: 12, supplier: 'Hotelbeds', board: 'Breakfast included', tone: 'sand' },
  { id: 'HTL-000241', name: 'The St. Regis Downtown Dubai', city: 'Dubai, United Arab Emirates', stars: 5, rating: 4.8, price: 690, rooms: 8, supplier: 'WebBeds', board: 'Room only', tone: 'blue' },
  { id: 'HTL-000319', name: 'Waldorf Astoria Dubai Palm Jumeirah', city: 'Dubai, United Arab Emirates', stars: 5, rating: 4.7, price: 540, rooms: 6, supplier: 'Direct contract', board: 'Half board', tone: 'teal' },
  { id: 'HTL-000401', name: 'Address Sky View', city: 'Dubai, United Arab Emirates', stars: 5, rating: 4.9, price: 760, rooms: 14, supplier: 'Hotelbeds', board: 'Bed & breakfast', tone: 'rose' },
]

export function AgentPortal() {
  const [query, setQuery] = useState('Dubai')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [stars, setStars] = useState(0)
  const [instant, setInstant] = useState(false)
  const [selected, setSelected] = useState<typeof hotels[number] | null>(null)
  const [toast, setToast] = useState('')
  const [sort, setSort] = useState('Recommended')

  const results = useMemo(() => hotels.filter((hotel) => {
    const matchesQuery = !query || `${hotel.name} ${hotel.city}`.toLowerCase().includes(query.toLowerCase())
    return matchesQuery && (!stars || hotel.stars >= stars) && (!instant || hotel.rooms >= 8)
  }).sort((a, b) => sort === 'Lowest price' ? a.price - b.price : b.rating - a.rating), [query, stars, instant, sort])

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2400) }

  return <div className="hotel-results-app">
    <header className="hotel-topbar">
      <div className="hotel-brand"><span className="hotel-brand-mark" aria-hidden="true">f</span><div><strong>fBeds</strong><small>WHOLESALE TRAVEL</small></div></div>
      <div className="hotel-top-search"><Search size={15} /><input aria-label="Global search" placeholder="Search hotels, bookings or guests" /><kbd>⌘ K</kbd></div>
      <div className="hotel-top-actions"><span className="hotel-live"><i /> LIVE INVENTORY</span><button onClick={() => notify('You have 3 new notifications')} aria-label="Notifications"><Bell size={17} /><b /></button><button onClick={() => notify('Help center opened')} aria-label="Help"><CircleHelp size={17} /></button><span className="hotel-avatar">JD</span><span className="hotel-user-name">Jordan Davis <ChevronDown size={13} /></span></div>
    </header>
    <main className="hotel-main">
      <div className="hotel-breadcrumb"><span>Atlas Getaways</span><b>/</b><strong>Search hotels</strong></div>
      <section className="hotel-page-heading"><div><span className="hotel-eyebrow">LIVE INVENTORY · DUBAI</span><h1>Search hotels</h1><p>Compare live wholesale rates across connected suppliers.</p></div><button className="hotel-help" onClick={() => notify('Help center opened')}><CircleHelp size={15} /> Need help?</button></section>
      <section className="hotel-search-panel"><div className="hotel-search-row"><label className="wide"><span>DESTINATION, HOTEL OR GIATA</span><div><MapPin size={15} /><input aria-label="Destination" value={query} onChange={e => setQuery(e.target.value)} /></div></label><label><span>CHECK-IN</span><div><CalendarDays size={15} /><input aria-label="Check-in" value="18 Sep 2026" readOnly /></div></label><label><span>CHECK-OUT</span><div><CalendarDays size={15} /><input aria-label="Check-out" value="21 Sep 2026" readOnly /></div></label><label><span>ROOMS & GUESTS</span><div><Users size={15} /><input aria-label="Rooms and guests" value="1 room · 2 guests" readOnly /></div></label><button className="hotel-search-button" onClick={() => notify(`${results.length * 24} properties found`)}><Search size={16} /> Search</button></div><div className="hotel-search-footer"><span><i /> Connected to 4 suppliers</span><button onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={14} /> Advanced filters <ChevronDown size={13} /></button></div>{filtersOpen && <div className="hotel-filter-drawer"><button className={stars === 5 ? 'chosen' : ''} onClick={() => setStars(stars === 5 ? 0 : 5)}><Star size={13} /> 5 stars</button><button className={instant ? 'chosen' : ''} onClick={() => setInstant(!instant)}><Check size={13} /> Instant confirmation</button><button onClick={() => { setStars(0); setInstant(false) }}>Clear all</button></div>}</section>
      <div className="hotel-result-layout"><aside className="hotel-filters"><div className="hotel-filter-heading"><strong>Filter results</strong><Filter size={15} /></div><div className="hotel-filter-group"><span>SUPPLIER</span>{['All suppliers', 'Hotelbeds', 'WebBeds', 'Direct contract'].map((item, i) => <label key={item}><input type="checkbox" defaultChecked={i === 0} /> {item}<em>{i === 0 ? 96 : 24}</em></label>)}</div><div className="hotel-filter-group"><span>STAR RATING</span>{[5, 4, 3].map(item => <label key={item}><input type="checkbox" checked={stars === item} onChange={() => setStars(stars === item ? 0 : item)} /> <b className="filter-stars">{'★'.repeat(item)}</b></label>)}</div><div className="hotel-filter-group"><span>BOARD BASIS</span>{['Room only', 'Breakfast included', 'Half board'].map(item => <label key={item}><input type="checkbox" /> {item}</label>)}</div><div className="hotel-filter-group"><span>RATE POLICY</span><label><input type="checkbox" checked={instant} onChange={() => setInstant(!instant)} /> Instant confirmation</label><label><input type="checkbox" /> Free cancellation</label></div></aside><section className="hotel-results"><div className="hotel-results-toolbar"><div><strong>{results.length * 24}</strong> properties found in <strong>{query || 'all destinations'}</strong><small>18 Sep — 21 Sep 2026 · 1 room · 2 guests</small></div><button onClick={() => setSort(sort === 'Recommended' ? 'Lowest price' : 'Recommended')}>Sort: {sort} <ChevronDown size={14} /></button></div>{results.length ? <div className="hotel-card-list">{results.map(hotel => <article className="hotel-result-card" key={hotel.id}><div className={`hotel-thumb ${hotel.tone}`}><span>{hotel.name.slice(0, 1)}</span><small>PHOTO</small></div><div className="hotel-result-info"><div className="hotel-result-title"><div><h2>{hotel.name}</h2><p><MapPin size={12} /> {hotel.city}</p><div className="hotel-rating">{'★'.repeat(hotel.stars)} <b>{hotel.rating}</b> <span>·</span> {hotel.board}</div></div><span className="hotel-instant"><Check size={12} /> Instant confirm</span></div><div className="hotel-rate-line"><div><span className="hotel-supplier">{hotel.supplier}</span><small>{hotel.rooms} rooms available · Free cancellation</small></div><div className="hotel-price"><small>From</small><strong>AED {hotel.price}</strong><span>per night · net rate</span></div><button onClick={() => setSelected(hotel)}>View rooms <ChevronDown size={14} /></button></div></div></article>)}</div> : <div className="hotel-empty"><Search size={20} /><strong>No hotels found</strong><span>Try another destination or clear your filters.</span></div>}</section></div>
    </main>
    {selected && <div className="hotel-modal-backdrop" onClick={() => setSelected(null)}><div className="hotel-modal" onClick={e => e.stopPropagation()}><button className="hotel-modal-close" onClick={() => setSelected(null)} aria-label="Close"><X size={17} /></button><span className="hotel-eyebrow">ROOMS & RATES · {selected.id}</span><h2>{selected.name}</h2><p><MapPin size={13} /> {selected.city}</p><div className="hotel-room"><div><strong>Deluxe King Room</strong><small>{selected.board} · Free cancellation until 16 Sep</small></div><b>AED {selected.price}<small>/ night</small></b></div><div className="hotel-room"><div><strong>Executive Suite</strong><small>Breakfast included · Sea view</small></div><b>AED {selected.price + 220}<small>/ night</small></b></div><button className="hotel-search-button full" onClick={() => { setSelected(null); notify('Room selected — booking flow opened') }}>Continue to booking <Search size={15} /></button></div></div>}
    {toast && <div className="hotel-toast">{toast}</div>}
  </div>
}
