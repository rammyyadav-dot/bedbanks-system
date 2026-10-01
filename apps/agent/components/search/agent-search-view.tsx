'use client'

import { useEffect, useRef, useState } from 'react'
import { MapPin, Search, ShieldAlert } from 'lucide-react'
import { SearchCriteriaForm } from '@/components/search/search-criteria-form'
import type { SearchCriteria, SearchHotelOffer, SearchRateOffer, SearchRoomOffer } from '@bedbanks/domain'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import { ApiHotelService } from '@/services/hotel-service'
import { formatMinorAmount, formatStay } from '@/lib/format'
import { recheckOutcomeMessage } from '@/lib/recheck-copy'
import { recheckResultApplies } from '@/lib/recheck-attempt'
import type { HotelSearchResult, OfferRecheckResult } from '@/types/hotel'
import { BookingCheckout } from '@/components/booking/booking-checkout'

export function SearchView({
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  guests, liveHotels, result, searching, loadingMore, loadMoreError, onSearch, onLoadMore,
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges, onCriteriaChange,
  bookingEnabled, tenantId, onBooked, onViewBooking,
}: {
  destination: string; setDestination: (value: string) => void
  checkIn: string; setCheckIn: (value: string) => void
  checkOut: string; setCheckOut: (value: string) => void
  guests: string; liveHotels: SearchHotelOffer[]
  result: HotelSearchResult | null; searching: boolean; loadingMore: boolean; loadMoreError: string; onSearch: () => void; onLoadMore: () => void
  rooms: number; setRooms: (value: number) => void
  adults: number; setAdults: (value: number) => void
  children: number; updateChildren: (value: number) => void
  childAges: number[]; setChildAges: (value: number[]) => void
  onCriteriaChange: () => void
  bookingEnabled: boolean; tenantId: string; onBooked: () => void; onViewBooking: (bookingId: string) => void
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
    <SearchCriteriaForm destination={destination} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut} rooms={rooms} setRooms={setRooms} adults={adults} setAdults={setAdults} children={children} updateChildren={updateChildren} childAges={childAges} setChildAges={setChildAges} searching={searching} onSubmit={submitSearch} onChange={update} destinationInvalid={Boolean(validationMessage && !destination.trim())} />
    {validationMessage && <p className="portal-field-error" role="alert">{validationMessage}</p>}
    {searching && <SearchLoadingState />}
    {result && !searching && <><div className="portal-results-meta"><div><strong>{liveHotels.length}</strong> of <strong>{result.pagination?.total ?? liveHotels.length}</strong> properties in <strong>{result.request.destination}</strong><small>{formatStay(result.request.checkIn, result.request.checkOut)} · {guests} · {result.request.currency}</small></div><button className="portal-link" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>Modify search</button></div>
      <div className={`portal-status-banner ${result.status === 'empty' ? 'is-empty' : result.status === 'provider_unavailable' ? 'is-error' : ''}`} role="status"><ShieldAlert size={15} /> {result.status === 'available' ? 'Verified supplier offers. Authoritative recheck is required before a booking can be held.' + (bookingEnabled ? '' : ' Booking remains disabled.') :
        result.status === 'partial' ? 'Some suppliers are unavailable. Verified offers from successful providers are shown.' :
        result.status === 'mapping_unavailable' ? 'Supplier offer mapping could not be verified. No rate is displayed.' :
        result.status === 'access_denied' ? 'You do not have access to this workspace.' :
        result.status === 'auth_required' ? 'Your session expired. Sign in again.' :
        result.status === 'empty' ? 'No availability for this search.' :
        'Supplier inventory is unavailable. Booking is disabled.'}</div>
      {selectedLive ? <LiveHotelDetail key={selectedLive.hotelId} hotel={selectedLive} request={result.request} searchId={result.hotelSearchIds?.[selectedLive.hotelId] ?? result.searchId} onBack={() => setSelectedLive(null)} bookingEnabled={bookingEnabled} tenantId={tenantId} onBooked={onBooked} onViewBooking={onViewBooking} /> :
        <div className="portal-results-layout"><div className="portal-hotel-list" data-result-count={liveHotels.length}>
          {liveHotels.map((hotel) => <LiveHotelCard key={hotel.hotelId} hotel={hotel} bookingEnabled={bookingEnabled} onSelect={() => setSelectedLive(hotel)} />)}
          {!liveHotels.length && <SearchOutcomeState status={result.status} onRetry={onSearch} onEdit={() => window.scrollTo({ top: 0, behavior: 'smooth' })} />}
          {liveHotels.length > 0 && result.pagination?.hasMore && <div className="portal-load-more"><button className="portal-secondary" type="button" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore}>{loadingMore ? 'Loading more hotels…' : 'Load more hotels'}</button></div>}
          {loadMoreError && <p className="portal-load-more-error" role="alert">{loadMoreError}</p>}
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
function LiveHotelCard({ hotel, onSelect, bookingEnabled }: { hotel: SearchHotelOffer; onSelect: () => void; bookingEnabled: boolean }) {
  const firstRate = hotel.rooms.flatMap((room) => room.rates).find((rate) => rate.availability !== 'sold_out')
  return <article className="portal-hotel-card"><div className="portal-hotel-content"><h2>{hotel.name}</h2><p><MapPin size={14} /> {hotel.destination}</p><div className="portal-hotel-bottom"><div><small>AUTHORITATIVE TOTAL STAY PRICE</small><strong>{firstRate ? formatTotal(firstRate.total) : 'No available rate'}</strong><span>{firstRate ? `${firstRate.boardBasisName}${bookingEnabled ? '' : ' · Booking remains disabled'}` : 'No available rate'}</span></div><button className="portal-secondary" onClick={onSelect}>View verified rooms & rates</button></div></div></article>
}
function LiveHotelDetail({ hotel, request, searchId, onBack, bookingEnabled, tenantId, onBooked, onViewBooking }: { hotel: SearchHotelOffer; request: SearchCriteria; searchId?: string; onBack: () => void; bookingEnabled: boolean; tenantId: string; onBooked: () => void; onViewBooking: (bookingId: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const [selection, setSelection] = useState<{ hotel: SearchHotelOffer; room: SearchRoomOffer; rate: SearchRateOffer; searchContext: SearchCriteria } | null>(null)
  const [recheck, setRecheck] = useState<OfferRecheckResult | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const recheckGeneration = useRef(0)
  const selectedOfferId = useRef('')
  const choose = (room: SearchRoomOffer, rate: SearchRateOffer) => {
    if (Date.parse(rate.expiresAt) <= Date.now() || rate.availability === 'sold_out') return
    recheckGeneration.current += 1
    selectedOfferId.current = rate.offerId
    setSelection({ hotel, room, rate, searchContext: request }); setRecheck(null); setRechecking(false)
  }
  const recheckOffer = async (acceptedMinor?: number) => {
    if (!selection || !searchId || rechecking) return
    const generation = recheckGeneration.current + 1
    recheckGeneration.current = generation
    const offerId = selection.rate.offerId
    selectedOfferId.current = offerId
    const expectedSellAmountMinor = acceptedMinor ?? selection.rate.sellAmountMinor
    setRechecking(true); setRecheck(null)
    const rate = { ...selection.rate, sellAmountMinor: expectedSellAmountMinor,
      total: { ...selection.rate.total, amountMinor: expectedSellAmountMinor } }
    const stillSelected = () => recheckResultApplies({ generation, offerId }, { generation: recheckGeneration.current, offerId: selectedOfferId.current })
    try {
      const result = await new ApiHotelService().recheckOffer(rate, searchId, selection.rate.tenantId)
      if (stillSelected()) setRecheck(result)
    } catch {
      if (stillSelected()) setRecheck({ status: 'provider_unavailable', offerId, searchId, requestId: 'unavailable' })
    } finally {
      if (generation === recheckGeneration.current) setRechecking(false)
    }
  }
  const canAcceptChangedPrice = recheck?.status === 'price_changed' && recheck.currency === selection?.rate.total.currency
  return <section className="portal-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button><div className="portal-detail-header"><div><span className="portal-eyebrow">VERIFIED SUPPLIER OFFERS</span><h2>{hotel.name}</h2><p>{hotel.destination} · {formatStay(request.checkIn, request.checkOut)} · {request.rooms} room · {request.adults} adults · {request.children} children · {request.currency}</p></div></div>
    {hotel.rooms.map((room) => <div className="portal-room" key={room.roomTypeId}><div><span className="portal-eyebrow">ROOM TYPE</span><h3>{room.name}</h3></div><div className="portal-rate">{room.rates.map((rate) => {
      const expired = Date.parse(rate.expiresAt) <= now
      const selectable = !expired && rate.availability !== 'sold_out'
      return <div key={rate.offerId} className="portal-rate-option"><span className="portal-eyebrow">RATE PLAN · BOARD BASIS</span><strong>{rate.ratePlanName} · {rate.boardBasisName}</strong><span>{rate.cancellation.summary} · {rate.availability.replace('_', ' ')} · {paymentLabel(rate.paymentType)}</span><div className="portal-rate-price"><b>{formatTotal(rate.total)} total stay</b><small>{rate.total.currency} · taxes {formatTotal({ currency: rate.total.currency, amountMinor: rate.taxAmountMinor })} · fees {formatTotal({ currency: rate.total.currency, amountMinor: rate.feeAmountMinor })} · expires {rate.expiresAt}</small></div><button className="portal-secondary" disabled={!selectable} onClick={() => choose(room, rate)}>{expired ? 'Rate expired' : rate.availability === 'sold_out' ? 'Unavailable' : 'Select rate for recheck'}</button></div>
    })}</div></div>)}
    {selection && Date.parse(selection.rate.expiresAt) <= now && <div className="portal-policy-note" role="status"><ShieldAlert size={16} />Selected rate expired. Search again for a current offer.</div>}
    {selection && Date.parse(selection.rate.expiresAt) > now && <div className="portal-hold-panel" aria-live="polite"><div><ShieldAlert size={16} /><span>Selected: {hotel.name} · {selection.room.name} · {selection.rate.boardBasisName} · {formatStay(request.checkIn, request.checkOut)} · {request.rooms} room · {request.adults} adults · {request.children} children · quoted {formatTotal(selection.rate.total)}. Offer expires {selection.rate.expiresAt}. Authoritative recheck is required{bookingEnabled ? ' before holding.' : '; booking remains disabled.'}</span></div>
      {!recheck || canAcceptChangedPrice || ['unavailable', 'provider_unavailable', 'mapping_invalid', 'rejected'].includes(recheck.status) ? <button className="portal-primary" disabled={rechecking || !searchId} onClick={() => void recheckOffer(canAcceptChangedPrice ? recheck?.sellAmountMinor : undefined)}>{rechecking ? 'Rechecking supplier…' : canAcceptChangedPrice ? 'Accept updated price and recheck' : 'Recheck rate'}</button> : null}
      {recheck && <RecheckOutcome result={recheck} quotedMinor={selection.rate.sellAmountMinor} quotedCurrency={selection.rate.total.currency} bookingEnabled={bookingEnabled} />}
      {bookingEnabled && recheck?.status === 'rechecked' && searchId && <BookingCheckout key={selection.rate.offerId} tenantId={tenantId} hotelName={hotel.name} roomName={selection.room.name} rate={selection.rate} searchId={searchId} request={request} onBooked={onBooked} onViewBooking={onViewBooking} />}</div>}
  </section>
}

function RecheckOutcome({ result, quotedMinor, quotedCurrency, bookingEnabled }: { result: OfferRecheckResult; quotedMinor: number; quotedCurrency: string; bookingEnabled: boolean }) {
  const current = result.status === 'price_changed' && result.currency && result.sellAmountMinor !== undefined ? { currency: result.currency, amountMinor: result.sellAmountMinor } : null
  return <div className={`portal-hold-outcome is-${result.status}`} role={result.status === 'rechecked' ? 'status' : 'alert'}><strong>{result.status === 'rechecked' ? 'Rate rechecked' : result.status.replace(/_/g, ' ')}</strong><span>{recheckOutcomeMessage(result.status, bookingEnabled)}</span>{current && <b>Previous {formatTotal({ currency: quotedCurrency, amountMinor: quotedMinor })} · Current {formatTotal(current)}</b>}</div>
}
