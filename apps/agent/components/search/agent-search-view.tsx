'use client'

import { useEffect, useState } from 'react'
import { CalendarDays, MapPin, Search, ShieldAlert } from 'lucide-react'
import type { SearchCriteria, SearchHotelOffer, SearchRateOffer, SearchRoomOffer } from '@bedbanks/domain'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import { ApiHotelService } from '@/services/hotel-service'
import { formatMinorAmount, formatStay } from '@/lib/format'
import type { HotelSearchResult, OfferRecheckResult } from '@/types/hotel'

export function SearchView({
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  guests, liveHotels, result, searching, onSearch, 
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges, onCriteriaChange,
}: {
  destination: string; setDestination: (value: string) => void
  checkIn: string; setCheckIn: (value: string) => void
  checkOut: string; setCheckOut: (value: string) => void
  guests: string; liveHotels: SearchHotelOffer[]
  result: HotelSearchResult | null; searching: boolean; onSearch: () => void
  rooms: number; setRooms: (value: number) => void
  adults: number; setAdults: (value: number) => void
  children: number; updateChildren: (value: number) => void
  childAges: number[]; setChildAges: (value: number[]) => void
  onCriteriaChange: () => void
}) {
  const [selectedLive, setSelectedLive] = useState<SearchHotelOffer | null>(null)
  const [validationMessage, setValidationMessage] = useState('')
  const criteria: SearchCriteria = { destination: destination.trim(), checkIn, checkOut, rooms, adults, children, childAges, nationality: 'IN', currency: 'AED' }
  const update = (action: () => void) => { setValidationMessage(''); onCriteriaChange(); setSelectedLive(null); action() }
  const submitSearch = () => {
    if (!criteria.destination) return setValidationMessage('Enter a destination.')
    if (!validSearchCriteria(criteria)) return setValidationMessage('Choose valid check-in and check-out dates and at least one adult.')
    setValidationMessage('')
    setSelectedLive(null)
    onSearch()
  }
  return <>
    <section className="portal-heading-row"><div><span className="portal-eyebrow">HOTEL SEARCH</span><h1>Search hotels</h1><p>Compare verified rooms, board basis and total stay rates.</p></div></section>
    <div className="portal-panel portal-search-panel"><div className="portal-search-form">
      <label className="portal-field wide"><span>DESTINATION</span><div className={validationMessage && !destination.trim() ? 'has-error' : ''}><MapPin size={16} /><input value={destination} onChange={(event) => update(() => setDestination(event.target.value))} aria-label="Destination" aria-invalid={Boolean(validationMessage && !destination.trim())} /></div></label>
      <label className="portal-field"><span>CHECK-IN</span><div><CalendarDays size={15} /><input type="date" value={checkIn} onChange={(event) => update(() => setCheckIn(event.target.value))} aria-label="Check-in" /></div></label>
      <label className="portal-field"><span>CHECK-OUT</span><div><CalendarDays size={15} /><input type="date" value={checkOut} onChange={(event) => update(() => setCheckOut(event.target.value))} aria-label="Check-out" /></div></label>
      <label className="portal-field"><span>ROOMS</span><div><input type="number" min={1} max={20} value={rooms} onChange={(event) => update(() => setRooms(Number(event.target.value)))} aria-label="Rooms" /></div></label>
      <label className="portal-field"><span>ADULTS</span><div><input type="number" min={1} max={40} value={adults} onChange={(event) => update(() => setAdults(Number(event.target.value)))} aria-label="Adults" /></div></label>
      <label className="portal-field"><span>CHILDREN</span><div><input type="number" min={0} max={40} value={children} onChange={(event) => update(() => updateChildren(Number(event.target.value)))} aria-label="Children" /></div></label>
      {childAges.map((age, index) => <label className="portal-field" key={index}><span>CHILD {index + 1} AGE</span><div><input type="number" min={0} max={17} value={age} onChange={(event) => update(() => setChildAges(childAges.map((value, position) => position === index ? Number(event.target.value) : value)))} aria-label={`Child ${index + 1} age`} /></div></label>)}
      <button className="portal-primary search-submit" onClick={submitSearch} disabled={searching}><Search size={16} /> {searching ? 'Searching…' : 'Search hotels'}</button>
    </div>{validationMessage && <p className="portal-field-error" role="alert">{validationMessage}</p>}<p>Nationality: IN · Currency: AED. Search uses the dates and occupancy shown above.</p></div>
    {searching && <SearchLoadingState />}
    {result && !searching && <><div className="portal-results-meta"><div><strong>{result.total}</strong> properties in <strong>{result.request.destination}</strong><small>{formatStay(result.request.checkIn, result.request.checkOut)} · {guests} · {result.request.currency}</small></div><button className="portal-link" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>Modify search</button></div>
      <div className={`portal-status-banner ${result.status === 'empty' ? 'is-empty' : result.status === 'provider_unavailable' ? 'is-error' : ''}`} role="status"><ShieldAlert size={15} /> {result.status === 'available' ? 'Verified supplier offers. Authoritative recheck is required before any future booking step; booking remains disabled.' :
        result.status === 'partial' ? 'Some suppliers are unavailable. Verified offers from successful providers are shown.' :
        result.status === 'mapping_unavailable' ? 'Supplier offer mapping could not be verified. No rate is displayed.' :
        result.status === 'access_denied' ? 'You do not have access to this workspace.' :
        result.status === 'auth_required' ? 'Your session expired. Sign in again.' :
        result.status === 'empty' ? 'No availability for this search.' :
        'Supplier inventory is unavailable. Booking is disabled.'}</div>
      {selectedLive ? <LiveHotelDetail key={selectedLive.hotelId} hotel={selectedLive} request={result.request} searchId={result.searchId} onBack={() => setSelectedLive(null)} /> :
        <div className="portal-results-layout"><div className="portal-hotel-list">
          {liveHotels.map((hotel) => <LiveHotelCard key={hotel.hotelId} hotel={hotel} onSelect={() => setSelectedLive(hotel)} />)}
          {!liveHotels.length && <SearchOutcomeState status={result.status} onRetry={onSearch} onEdit={() => window.scrollTo({ top: 0, behavior: 'smooth' })} />}
        </div></div>}</>}
  </>
}

function SearchLoadingState() {
  return <section className="portal-search-loading" aria-live="polite" aria-busy="true"><div className="portal-search-loading-heading"><span className="portal-spinner" aria-hidden="true" /><div><strong>Searching available hotels…</strong><p>Checking supplier availability and rates</p></div></div><div className="portal-skeleton-list"><span /><span /><span /></div></section>
}
function SearchOutcomeState({ status, onRetry, onEdit }: { status: HotelSearchResult['status']; onRetry: () => void; onEdit: () => void }) {
  const unavailable = ['provider_unavailable', 'auth_required', 'access_denied'].includes(status)
  const mapping = status === 'mapping_unavailable'
  const title = unavailable ? 'Rates temporarily unavailable' : mapping ? 'This offer is not available for booking yet' : status === 'empty' ? 'No available hotels found' : 'We couldn’t complete this hotel search'
  const copy = unavailable ? 'We couldn’t retrieve live supplier rates for this search.' : mapping ? 'The supplier offer could not be verified against the fBeds hotel and room catalogue.' : status === 'empty' ? 'No live offers matched your current destination, dates and occupancy.' : 'Your search details are preserved. Try again or adjust the search criteria.'
  return <div className="portal-empty portal-outcome"><Search size={20} /><h2>{title}</h2><p>{copy}</p><div><button className="portal-primary" onClick={onRetry}>Try again</button><button className="portal-link" onClick={onEdit}>Edit search</button></div></div>
}
function paymentLabel(paymentType: SearchRateOffer['paymentType']) { return paymentType === 'pay_at_hotel' ? 'Pay at hotel' : paymentType === 'prepaid' ? 'Prepaid' : 'Agency credit' }
function formatTotal(total: SearchRateOffer['total']) { return formatMinorAmount(total.amountMinor, total.currency) ?? 'Price unavailable' }
function LiveHotelCard({ hotel, onSelect }: { hotel: SearchHotelOffer; onSelect: () => void }) {
  const firstRate = hotel.rooms.flatMap((room) => room.rates).find((rate) => rate.availability !== 'sold_out')
  return <article className="portal-hotel-card"><div className="portal-hotel-content"><h2>{hotel.name}</h2><p><MapPin size={14} /> {hotel.destination}</p><div className="portal-hotel-bottom"><div><small>AUTHORITATIVE TOTAL STAY PRICE</small><strong>{firstRate ? formatTotal(firstRate.total) : 'No available rate'}</strong><span>Rate recheck and booking unavailable</span></div><button className="portal-secondary" onClick={onSelect}>View verified rooms & rates</button></div></div></article>
}
function LiveHotelDetail({ hotel, request, searchId, onBack }: { hotel: SearchHotelOffer; request: SearchCriteria; searchId?: string; onBack: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const [selection, setSelection] = useState<{ hotel: SearchHotelOffer; room: SearchRoomOffer; rate: SearchRateOffer; searchContext: SearchCriteria } | null>(null)
  const [recheck, setRecheck] = useState<OfferRecheckResult | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [expectedAmount, setExpectedAmount] = useState<number | null>(null)
  const choose = (room: SearchRoomOffer, rate: SearchRateOffer) => {
    if (Date.parse(rate.expiresAt) <= Date.now() || rate.availability === 'sold_out') return
    setSelection({ hotel, room, rate, searchContext: request }); setRecheck(null); setExpectedAmount(rate.sellAmountMinor)
  }
  const recheckOffer = async () => {
    if (!selection || !searchId || rechecking || expectedAmount === null) return
    setRechecking(true); setRecheck(null)
    const rate = { ...selection.rate, sellAmountMinor: expectedAmount,
      total: { ...selection.rate.total, amountMinor: expectedAmount } }
    try {
      const result = await new ApiHotelService().recheckOffer(rate, searchId, selection.rate.tenantId)
      setRecheck(result)
      if (result.status === 'price_changed' && result.sellAmountMinor !== undefined) setExpectedAmount(result.sellAmountMinor)
    } catch {
      setRecheck({ status: 'provider_unavailable', offerId: selection.rate.offerId, searchId, requestId: 'unavailable' })
    } finally {
      setRechecking(false)
    }
  }
  const canAcceptChangedPrice = recheck?.status === 'price_changed' && recheck.currency === selection?.rate.total.currency
  return <section className="portal-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button><div className="portal-detail-header"><div><span className="portal-eyebrow">VERIFIED SUPPLIER OFFERS</span><h2>{hotel.name}</h2><p>{hotel.destination}</p></div></div>
    {hotel.rooms.map((room) => <div className="portal-room" key={room.roomTypeId}><div><span className="portal-eyebrow">ROOM TYPE</span><h3>{room.name}</h3></div><div className="portal-rate">{room.rates.map((rate) => {
      const expired = Date.parse(rate.expiresAt) <= now
      const selectable = !expired && rate.availability !== 'sold_out'
      return <div key={rate.offerId} className="portal-rate-option"><span className="portal-eyebrow">RATE PLAN · BOARD BASIS</span><strong>{rate.ratePlanName} · {rate.boardBasisName}</strong><span>{rate.cancellation.summary} · {rate.availability.replace('_', ' ')} · {paymentLabel(rate.paymentType)}</span><div className="portal-rate-price"><b>{formatTotal(rate.total)} total stay</b><small>Includes taxes {formatTotal({ currency: rate.total.currency, amountMinor: rate.taxAmountMinor })} · fees {formatTotal({ currency: rate.total.currency, amountMinor: rate.feeAmountMinor })}</small></div><button className="portal-secondary" disabled={!selectable} onClick={() => choose(room, rate)}>{expired ? 'Rate expired' : rate.availability === 'sold_out' ? 'Unavailable' : 'Select rate for recheck'}</button></div>
    })}</div></div>)}
    {selection && Date.parse(selection.rate.expiresAt) <= now && <div className="portal-policy-note" role="status"><ShieldAlert size={16} />Selected rate expired. Search again for a current offer.</div>}
    {selection && Date.parse(selection.rate.expiresAt) > now && <div className="portal-hold-panel" aria-live="polite"><div><ShieldAlert size={16} /><span>Selected: {selection.room.name} · {selection.rate.ratePlanName} · {selection.rate.boardBasisName} · {formatTotal({ ...selection.rate.total, amountMinor: expectedAmount ?? selection.rate.sellAmountMinor })}. Authoritative recheck is required; booking remains disabled.</span></div>
      {!recheck || canAcceptChangedPrice || ['unavailable', 'provider_unavailable', 'mapping_invalid', 'rejected'].includes(recheck.status) ? <button className="portal-primary" disabled={rechecking || !searchId} onClick={recheckOffer}>{rechecking ? 'Rechecking supplier…' : canAcceptChangedPrice ? 'Accept updated price & recheck' : 'Recheck rate'}</button> : null}
      {recheck && <RecheckOutcome result={recheck} />}</div>}
  </section>
}

function RecheckOutcome({ result }: { result: OfferRecheckResult }) {
  const messages: Record<OfferRecheckResult['status'], string> = {
    rechecked: 'Rate rechecked against current supplier and canonical commercial state. Booking remains disabled pending certification.',
    price_changed: 'The supplier price or currency changed. Review the updated total; a currency change requires a new search.',
    unavailable: 'The rate is no longer available. No inventory was allocated.', offer_expired: 'The offer expired. Search again for a current rate.',
    mapping_invalid: 'The hotel, room or commercial mapping could not be verified. No inventory was allocated.',
    provider_unavailable: 'The supplier could not be reached safely. No inventory was allocated. Try the recheck again.', rejected: 'The supplier response could not be verified. No inventory was allocated.',
    auth_required: 'Your session expired. Sign in again.', access_denied: 'You do not have permission to recheck this offer.',
  }
  return <div className={`portal-hold-outcome is-${result.status}`} role={result.status === 'rechecked' ? 'status' : 'alert'}><strong>{result.status === 'rechecked' ? 'Rate rechecked' : result.status.replace(/_/g, ' ')}</strong><span>{messages[result.status]}</span>{result.status === 'price_changed' && result.currency && result.sellAmountMinor !== undefined && <b>{formatTotal({ currency: result.currency, amountMinor: result.sellAmountMinor })}</b>}</div>
}
