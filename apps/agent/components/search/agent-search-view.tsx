'use client'

import { useEffect, useState } from 'react'
import { CalendarDays, MapPin, Search, ShieldAlert } from 'lucide-react'
import type { SearchCriteria, SearchHotelOffer, SearchRateOffer, SearchRoomOffer } from '@bedbanks/domain'
import type { Hotel, HotelSearchResult } from '@/types/hotel'

export function SearchView({
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
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const [selection, setSelection] = useState<{ hotel: SearchHotelOffer; room: SearchRoomOffer; rate: SearchRateOffer; searchContext: SearchCriteria } | null>(null)
  return <section className="portal-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button><div className="portal-detail-header"><div><span className="portal-eyebrow">VERIFIED SUPPLIER OFFERS</span><h2>{hotel.name}</h2><p>{hotel.destination}</p></div></div>
    {hotel.rooms.map((room) => <div className="portal-room" key={room.roomTypeId}><div><span className="portal-eyebrow">ROOM TYPE</span><h3>{room.name}</h3></div><div className="portal-rate">{room.rates.map((rate) => {
      const expired = Date.parse(rate.expiresAt) <= now
      const selectable = !expired && rate.availability !== 'sold_out'
      return <div key={rate.offerId}><span className="portal-eyebrow">RATE PLAN · BOARD BASIS</span><strong>{rate.ratePlanName} · {rate.boardBasisName}</strong><span>{rate.cancellation.summary} · {rate.availability.replace('_', ' ')}</span><b>{formatTotal(rate.total)} total stay</b><button className="portal-secondary" disabled={!selectable} onClick={() => { if (Date.parse(rate.expiresAt) > Date.now() && rate.availability !== 'sold_out') setSelection({ hotel, room, rate, searchContext: request }) }}>{expired ? 'Rate expired' : rate.availability === 'sold_out' ? 'Unavailable' : 'Select rate for review'}</button></div>
    })}</div></div>)}
    {selection && Date.parse(selection.rate.expiresAt) <= now && <div className="portal-policy-note" role="status"><ShieldAlert size={16} />Selected rate expired. Search again for a current offer.</div>}
    {selection && Date.parse(selection.rate.expiresAt) > now && <div className="portal-policy-note" role="status"><ShieldAlert size={16} /><span>Selected: {selection.room.name} · {selection.rate.ratePlanName} · {selection.rate.boardBasisName} · {formatTotal(selection.rate.total)}. Authoritative recheck is unavailable; booking cannot proceed.</span><button disabled>Booking unavailable</button></div>}
  </section>
}
function HotelCard({ hotel, onSelect }: { hotel: Hotel; onSelect: () => void }) { return <article className="portal-hotel-card"><img src={hotel.image} alt={`${hotel.name} exterior`} /><div className="portal-hotel-content"><div className="portal-hotel-title"><div><h2>{hotel.name}</h2><span className="portal-stars">{'★'.repeat(hotel.stars)}</span><p><MapPin size={14} /> {hotel.city} · {hotel.distance}</p></div><span className="portal-score">{hotel.rating.toFixed(1)}<small>/5</small></span></div><div className="portal-hotel-tags"><span>{hotel.board}</span><span className="success">{hotel.cancellation}</span></div><div className="portal-hotel-bottom"><div><small>ILLUSTRATIVE SAMPLE AMOUNT · NOT BOOKABLE</small><strong>AED {hotel.price.toLocaleString()}</strong></div><button className="portal-secondary" onClick={onSelect}>View sample details</button></div></div></article> }
function HotelDetail({ hotel, onBack }: { hotel: Hotel; onBack: () => void }) { return <section className="portal-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button><div className="portal-detail-header"><div><span className="portal-eyebrow">SAMPLE PROPERTY · NOT BOOKABLE</span><h2>{hotel.name}</h2><p><MapPin size={14} /> {hotel.city}</p></div></div><div className="portal-policy-note"><ShieldAlert size={16} /> No authoritative room, rate or policy is available for this sample property. Booking is disabled.</div></section> }
