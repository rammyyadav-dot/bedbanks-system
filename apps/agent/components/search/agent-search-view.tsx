'use client'

import { useEffect, useRef, useState } from 'react'
import { MapPin, Search, ShieldAlert } from 'lucide-react'
import { SearchCriteriaForm } from '@/components/search/search-criteria-form'
import type { SearchCriteria, SearchHotelOffer, SearchRateOffer, SearchRoomOffer } from '@bedbanks/domain'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import { ApiHotelService } from '@/services/hotel-service'
import { includesBreakfast } from '@/lib/board-basis'
import { marketplaceHome } from '@/lib/marketplace-content'
import { selectableRoomCount, selectableRoomLabel } from '@/lib/room-options'
import { formatCompactStay, formatMinorAmount, formatMinorDelta, formatStay } from '@/lib/format'
import { guestMarketName } from '@/lib/guest-market'
import { resolvedChildAges, type DraftChildAge } from '@/lib/occupancy'
import { criteriaFilters, type FilterDraft } from '@/lib/search-filters'
import { activeFilterLabel, stayOccupancyLabel } from '@/lib/search-summary'
import { recheckOutcomeMessage, recheckOutcomeTitle } from '@/lib/recheck-copy'
import { priceChangeDisplay, recheckBaselineMinor, recheckResultApplies } from '@/lib/recheck-attempt'
import type { HotelSearchResult, OfferRecheckResult } from '@/types/hotel'
import { BookingCheckout } from '@/components/booking/booking-checkout'

export function SearchView({
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  liveHotels, result, searching, searchFailed, loadingMore, loadMoreError, onSearch, onLoadMore,
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges, onCriteriaChange,
  nationality, setNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
  minPriceAed, setMinPriceAed, maxPriceAed, setMaxPriceAed,
  bookingEnabled, tenantId, onBooked, onViewBooking,
}: {
  destination: string; setDestination: (value: string) => void
  checkIn: string; setCheckIn: (value: string) => void
  checkOut: string; setCheckOut: (value: string) => void
  liveHotels: SearchHotelOffer[]
  result: HotelSearchResult | null; searching: boolean; searchFailed: boolean; loadingMore: boolean; loadMoreError: string; onSearch: () => void; onLoadMore: () => void
  rooms: number; setRooms: (value: number) => void
  adults: number; setAdults: (value: number) => void
  children: number; updateChildren: (value: number) => void
  childAges: DraftChildAge[]; setChildAges: (value: DraftChildAge[]) => void
  onCriteriaChange: () => void
  nationality: string; setNationality: (value: string) => void
  starRatings: number[]; setStarRatings: (value: number[]) => void
  refundableOnly: boolean; setRefundableOnly: (value: boolean) => void
  minPriceAed: string; setMinPriceAed: (value: string) => void
  maxPriceAed: string; setMaxPriceAed: (value: string) => void
  bookingEnabled: boolean; tenantId: string; onBooked: () => void; onViewBooking: (bookingId: string) => void
}) {
  const [selectedLive, setSelectedLive] = useState<SearchHotelOffer | null>(null)
  const [validationMessage, setValidationMessage] = useState('')
  const draft: FilterDraft = { starRatings, refundableOnly, minPriceAed, maxPriceAed }
  const parsedFilters = criteriaFilters(draft)
  const ages = resolvedChildAges(children, childAges)
  const criteria: SearchCriteria | null = ages ? {
    destination: destination.trim(), checkIn, checkOut, rooms, adults, children, childAges: ages, nationality, currency: 'AED',
    ...(parsedFilters.ok && parsedFilters.filters ? { filters: parsedFilters.filters } : {}),
  } : null
  const update = (action: () => void) => { setValidationMessage(''); onCriteriaChange(); setSelectedLive(null); action() }
  const submitSearch = () => {
    if (!destination.trim()) return setValidationMessage('Enter a destination.')
    if (!parsedFilters.ok) return setValidationMessage(parsedFilters.reason)
    if (!ages || !criteria) return setValidationMessage('Choose an age for each child.')
    if (!validSearchCriteria(criteria)) return setValidationMessage('Choose valid check-in and check-out dates and at least one adult.')
    setValidationMessage('')
    setSelectedLive(null)
    onSearch()
  }
  const request = result?.request
  const total = result?.pagination?.total ?? liveHotels.length
  const pageSize = result?.pagination?.limit
  return <>
    <SearchCriteriaForm destination={destination} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut} rooms={rooms} setRooms={setRooms} adults={adults} setAdults={setAdults} children={children} updateChildren={updateChildren} childAges={childAges} setChildAges={setChildAges} nationality={nationality} setNationality={setNationality} starRatings={starRatings} setStarRatings={setStarRatings} refundableOnly={refundableOnly} setRefundableOnly={setRefundableOnly} minPriceAed={minPriceAed} setMinPriceAed={setMinPriceAed} maxPriceAed={maxPriceAed} setMaxPriceAed={setMaxPriceAed} searching={searching} searchFailed={searchFailed} onSubmit={submitSearch} onChange={update} destinationInvalid={Boolean(validationMessage && !destination.trim())} />
    {validationMessage && <p className="portal-field-error" role="alert">{validationMessage}</p>}
    {searching && <SearchLoadingState />}
    {result && request && !searching && <>
      <div className="market-criteria-bar">
        <p>
          <b>{request.destination}</b>
          <b>{formatCompactStay(request.checkIn, request.checkOut)}</b>
          <b>{stayOccupancyLabel(request.rooms, request.adults, request.children, request.childAges)}</b>
          <b>{guestMarketName(request.nationality)}</b>
          {request.filters && activeFilterLabel({ ...request.filters, currency: request.currency }) ? <b>{activeFilterLabel({ ...request.filters, currency: request.currency })}</b> : null}
        </p>
        <button className="portal-link" type="button" onClick={() => document.getElementById('hotel-search')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Modify</button>
      </div>
      <div className="portal-results-meta market-results-bar"><p>Showing <strong>{liveHotels.length}</strong> of <strong>{total}</strong> hotels</p><span>{formatStay(request.checkIn, request.checkOut)} · {request.currency}</span></div>
      <div className={`portal-status-banner ${result.status === 'empty' ? 'is-empty' : result.status === 'provider_unavailable' ? 'is-error' : ''}`} role="status"><ShieldAlert size={15} /> {statusCopy(result.status)}</div>
      {selectedLive ? <LiveHotelDetail key={selectedLive.hotelId} hotel={selectedLive} request={request} searchId={result.hotelSearchIds?.[selectedLive.hotelId] ?? result.searchId} onBack={() => setSelectedLive(null)} onRefresh={onSearch} bookingEnabled={bookingEnabled} tenantId={tenantId} onBooked={onBooked} onViewBooking={onViewBooking} /> :
        <div className="market-results"><div className="portal-hotel-list" data-result-count={liveHotels.length}>
          {liveHotels.map((hotel) => <LiveHotelCard key={hotel.hotelId} hotel={hotel} onSelect={() => setSelectedLive(hotel)} />)}
          {!liveHotels.length && <SearchOutcomeState status={result.status} onRetry={onSearch} onEdit={() => document.getElementById('hotel-search')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />}
          {liveHotels.length > 0 && result.pagination?.hasMore && <div className="portal-load-more"><button className="portal-secondary" type="button" onClick={onLoadMore} disabled={loadingMore} aria-busy={loadingMore}>{loadingMore ? 'Loading more hotels…' : pageSize ? `Load ${pageSize} more hotels` : 'Load more hotels'}</button></div>}
          {loadMoreError && <p className="portal-load-more-error" role="alert">{loadMoreError}</p>}
        </div></div>}</>}
  </>
}

function statusCopy(status: HotelSearchResult['status']) {
  if (status === 'available') return marketplaceHome.resultsQuote
  if (status === 'partial') return 'Some hotel inventory is temporarily unavailable. We could not retrieve rates from one inventory source. Your other available results are still shown.'
  if (status === 'mapping_unavailable') return 'Supplier offer mapping could not be verified. No rate is displayed.'
  if (status === 'access_denied') return 'You do not have access to this workspace.'
  if (status === 'auth_required') return 'Your session expired. Sign in again.'
  if (status === 'empty') return 'No hotels matched this search. This is not a supplier outage.'
  return 'Search is temporarily unavailable. Please try again.'
}

function SearchLoadingState() {
  return <section className="portal-search-loading" aria-live="polite" aria-busy="true"><div className="portal-search-loading-heading"><span className="portal-spinner" aria-hidden="true" /><div><strong>Searching available hotels…</strong><p>Checking supplier availability and rates</p></div></div><div className="portal-skeleton-list"><span /><span /><span /></div></section>
}
function SearchOutcomeState({ status, onRetry, onEdit }: { status: HotelSearchResult['status']; onRetry: () => void; onEdit: () => void }) {
  const unavailable = ['provider_unavailable', 'auth_required', 'access_denied'].includes(status)
  const mapping = status === 'mapping_unavailable'
  const title = unavailable ? 'Search is temporarily unavailable.' : mapping ? 'This offer is not available for booking yet' : status === 'empty' ? 'No hotels matched this search.' : 'We couldn’t complete this hotel search'
  const copy = unavailable ? 'Please try again in a moment.' : mapping ? 'The supplier offer could not be verified against the fBeds hotel and room catalogue.' : status === 'empty' ? 'Change the dates, broaden the destination, or clear filters. This is not a supplier outage.' : 'Your search details are preserved. Try again or adjust the search criteria.'
  return <div className="portal-empty portal-outcome"><Search size={20} /><h2>{title}</h2><p>{copy}</p><div>{unavailable ? <button className="portal-primary" onClick={onRetry}>Try again</button> : <button className="portal-primary" onClick={onEdit}>Modify search</button>}{!unavailable && <button className="portal-link" onClick={onRetry}>Try again</button>}</div></div>
}
function paymentLabel(paymentType: SearchRateOffer['paymentType']) { return paymentType === 'pay_at_hotel' ? 'Pay at hotel' : paymentType === 'prepaid' ? 'Prepaid' : 'Agency credit' }
function formatTotal(total: SearchRateOffer['total']) { return formatMinorAmount(total.amountMinor, total.currency) ?? 'Price unavailable' }
function hotelInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || 'H'
}
function starLabel(rating: number) {
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0
}
function StarMark({ rating }: { rating: number }) {
  const stars = starLabel(rating)
  if (!stars) return null
  return <span className="market-stars" aria-label={`${stars} star${stars === 1 ? '' : 's'}`}>{'★'.repeat(stars)}<span aria-hidden="true">{'☆'.repeat(5 - stars)}</span></span>
}
function cancellationLine(rate: SearchRateOffer) {
  const summary = rate.cancellation.summary.trim()
  if (rate.cancellation.refundable && !/free cancellation/i.test(summary)) return summary ? `${summary} · Free cancellation` : 'Free cancellation'
  return summary || 'Non-refundable'
}
function leadStay(hotel: SearchHotelOffer) {
  let lead: { room: SearchRoomOffer; rate: SearchRateOffer } | null = null
  for (const room of hotel.rooms) {
    for (const rate of room.rates) {
      if (rate.availability === 'sold_out') continue
      if (!lead || (rate.total.currency === lead.rate.total.currency && rate.sellAmountMinor < lead.rate.sellAmountMinor)) lead = { room, rate }
    }
  }
  return lead
}
function LiveHotelCard({ hotel, onSelect }: { hotel: SearchHotelOffer; onSelect: () => void }) {
  const lead = leadStay(hotel)
  const rate = lead?.rate
  const roomOptions = selectableRoomLabel(selectableRoomCount(hotel.rooms))
  return <article className="portal-hotel-card market-hotel-card market-stay-card">
    <div className="market-hotel-mark" aria-hidden="true">{hotelInitial(hotel.name)}</div>
    <div className="market-stay-body">
      <div className="market-stay-copy">
        <div className="market-stay-name"><h2>{hotel.name}</h2><StarMark rating={hotel.starRating} /></div>
        <p className="market-stay-place"><MapPin size={14} /> {hotel.destination}</p>
        {lead && <p className="market-stay-room">{lead.room.name}</p>}
        {rate && <p className="market-stay-facts">{stayOccupancyLabel(rate.occupancy.rooms, rate.occupancy.adults, rate.occupancy.children, rate.occupancy.childAges)} · {cancellationLine(rate)} · {rate.boardBasisName}</p>}
        {rate && <div className="market-badges">{rate.cancellation.refundable && <span className="is-cancel">Free cancellation</span>}{includesBreakfast(rate.boardBasisName) && <span className="is-meal">Breakfast included</span>}{rate.availability === 'limited' && <span>Limited availability</span>}</div>}
      </div>
      <div className="market-stay-price">
        <small>{rate ? 'Total stay' : 'Rate'}</small>
        <strong>{rate ? formatTotal(rate.total) : 'No available rate'}</strong>
        {rate && <span>{rate.boardBasisName}</span>}
        <button className="portal-primary" type="button" onClick={onSelect} aria-label={`View rooms for ${hotel.name}`}>View rooms</button>
        {hotel.rooms.length > 0 && <small>{roomOptions}</small>}
      </div>
    </div>
  </article>
}
function LiveHotelDetail({ hotel, request, searchId, onBack, onRefresh, bookingEnabled, tenantId, onBooked, onViewBooking }: { hotel: SearchHotelOffer; request: SearchCriteria; searchId?: string; onBack: () => void; onRefresh: () => void; bookingEnabled: boolean; tenantId: string; onBooked: () => void; onViewBooking: (bookingId: string) => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const [selection, setSelection] = useState<{ hotel: SearchHotelOffer; room: SearchRoomOffer; rate: SearchRateOffer; searchContext: SearchCriteria } | null>(null)
  const [acceptedMinor, setAcceptedMinor] = useState<number | null>(null)
  const [recheck, setRecheck] = useState<OfferRecheckResult | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const recheckGeneration = useRef(0)
  const selectedOfferId = useRef('')
  const runRecheck = async (rate: SearchRateOffer, expectedMinor: number, generation: number) => {
    const offerId = rate.offerId
    selectedOfferId.current = offerId
    if (!searchId) { if (generation === recheckGeneration.current) setRechecking(false); return }
    const stillSelected = () => recheckResultApplies({ generation, offerId }, { generation: recheckGeneration.current, offerId: selectedOfferId.current })
    setRechecking(true)
    setRecheck(null)
    try {
      const result = await new ApiHotelService().recheckOffer({ ...rate, sellAmountMinor: expectedMinor, total: { ...rate.total, amountMinor: expectedMinor } }, searchId, rate.tenantId)
      if (stillSelected()) setRecheck(result)
    } catch {
      if (stillSelected()) setRecheck({ status: 'provider_unavailable', offerId, searchId, requestId: 'unavailable' })
    } finally {
      if (generation === recheckGeneration.current) setRechecking(false)
    }
  }
  const choose = (room: SearchRoomOffer, rate: SearchRateOffer) => {
    if (Date.parse(rate.expiresAt) <= Date.now() || rate.availability === 'sold_out') return
    const generation = recheckGeneration.current + 1
    recheckGeneration.current = generation
    setAcceptedMinor(null)
    setSelection({ hotel, room, rate, searchContext: request })
    void runRecheck(rate, rate.sellAmountMinor, generation)
  }
  const acceptPrice = () => {
    if (!selection || recheck?.status !== 'price_changed' || recheck.sellAmountMinor === undefined || recheck.currency !== selection.rate.total.currency) return
    const accepted = recheck.sellAmountMinor
    setAcceptedMinor(accepted)
    const generation = recheckGeneration.current + 1
    recheckGeneration.current = generation
    void runRecheck(selection.rate, accepted, generation)
  }
  const canAcceptChangedPrice = recheck?.status === 'price_changed' && recheck.currency === selection?.rate.total.currency && recheck.sellAmountMinor !== undefined
  const baselineMinor = selection ? recheckBaselineMinor(selection.rate.sellAmountMinor, acceptedMinor) : 0
  const priceMove = selection && recheck?.status === 'price_changed' && recheck.sellAmountMinor !== undefined
    ? priceChangeDisplay({ searchQuoteMinor: selection.rate.sellAmountMinor, baselineMinor, currentMinor: recheck.sellAmountMinor })
    : null
  const quoted = selection ? formatTotal(acceptedMinor === null ? selection.rate.total : { currency: selection.rate.total.currency, amountMinor: baselineMinor }) : ''
  return <section className="portal-detail market-hotel-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button>
    <div className="market-detail-head"><div className="market-hotel-mark" aria-hidden="true">{hotelInitial(hotel.name)}</div><div><div className="market-stay-name"><h2>{hotel.name}</h2><StarMark rating={hotel.starRating} /></div><p>{hotel.destination} · {formatStay(request.checkIn, request.checkOut)} · {stayOccupancyLabel(request.rooms, request.adults, request.children, request.childAges)} · {guestMarketName(request.nationality)} · {request.currency}</p></div></div>
    {hotel.rooms.map((room) => <div className="market-room-group" key={room.roomTypeId}><header><h3>{room.name}</h3><span>{room.rates.length} {room.rates.length === 1 ? 'rate' : 'rates'}</span></header><div>{room.rates.map((rate) => {
      const expired = Date.parse(rate.expiresAt) <= now
      const selectable = !expired && rate.availability !== 'sold_out'
      const selected = selection?.rate.offerId === rate.offerId
      return <div key={rate.offerId} className={`market-rate-row${selected ? ' is-selected' : ''}`}><div className="market-rate-plan"><strong>{rate.ratePlanName}</strong><span>{rate.boardBasisName}</span>{includesBreakfast(rate.boardBasisName) && <em>Breakfast included</em>}</div><div className="market-rate-policy"><span>{cancellationLine(rate)}</span><span>{stayOccupancyLabel(rate.occupancy.rooms, rate.occupancy.adults, rate.occupancy.children, rate.occupancy.childAges)} · {rate.availability === 'limited' ? 'Limited availability' : rate.availability.replace('_', ' ')} · {paymentLabel(rate.paymentType)}</span></div><div className="market-rate-price"><b>{formatTotal(rate.total)}</b><small>Total stay · taxes {formatTotal({ currency: rate.total.currency, amountMinor: rate.taxAmountMinor })} · fees {formatTotal({ currency: rate.total.currency, amountMinor: rate.feeAmountMinor })}</small></div><button className="portal-primary" type="button" disabled={!selectable || (selected && rechecking)} onClick={() => choose(room, rate)}>{expired ? 'Rate expired' : rate.availability === 'sold_out' ? 'Unavailable' : 'Select Offer'}</button></div>
    })}</div></div>)}
    {selection && Date.parse(selection.rate.expiresAt) <= now && <div className="portal-policy-note" role="status"><ShieldAlert size={16} /> This rate has expired. Refresh the latest rates to continue.</div>}
    {selection && !searchId && <p className="portal-field-error" role="alert">This result has no search identifier, so the offer cannot be rechecked.</p>}
    {selection && Date.parse(selection.rate.expiresAt) > now && <div className="portal-hold-panel" aria-live="polite"><div><ShieldAlert size={16} /><span>Selected offer {selection.room.name} · {selection.rate.boardBasisName} · {acceptedMinor === null ? `quoted ${quoted}` : `accepted ${quoted} · search quote ${formatTotal(selection.rate.total)}`}. Recheck uses this offer.</span></div>
      {rechecking && <p role="status">Checking latest price & availability…</p>}
      {canAcceptChangedPrice && !rechecking && <div className="market-recheck-actions"><button className="portal-primary" type="button" onClick={acceptPrice}>Accept New Price</button><button className="portal-link" type="button" onClick={() => { recheckGeneration.current += 1; setSelection(null); setRecheck(null) }}>Choose Another Offer</button></div>}
      {recheck?.status === 'unavailable' && !rechecking && <div className="market-recheck-actions"><button className="portal-primary" type="button" onClick={() => { recheckGeneration.current += 1; setSelection(null); setRecheck(null) }}>View alternative rooms</button><button className="portal-link" type="button" onClick={onRefresh}>Search again</button></div>}
      {recheck?.status === 'offer_expired' && !rechecking && <button className="portal-primary" type="button" onClick={onRefresh}>Refresh rates</button>}
      {(recheck?.status === 'provider_unavailable' || recheck?.status === 'rejected' || recheck?.status === 'mapping_invalid') && !rechecking && <button className="portal-primary" type="button" onClick={() => choose(selection.room, selection.rate)}>Try again</button>}
      {recheck && <RecheckOutcome result={recheck} currency={selection.rate.total.currency} priceMove={priceMove} bookingEnabled={bookingEnabled} />}
      {bookingEnabled && recheck?.status === 'rechecked' && searchId && <BookingCheckout key={selection.rate.offerId} tenantId={tenantId} hotelName={hotel.name} roomName={selection.room.name} rate={selection.rate} searchId={searchId} request={request} onBooked={onBooked} onViewBooking={onViewBooking} />}</div>}
  </section>
}

function RecheckOutcome({ result, currency, priceMove, bookingEnabled }: { result: OfferRecheckResult; currency: string; priceMove: { previousMinor: number; currentMinor: number; searchQuoteMinor: number | null } | null; bookingEnabled: boolean }) {
  const delta = priceMove && result.currency === currency ? formatMinorDelta(priceMove.previousMinor, priceMove.currentMinor, currency) : null
  return <div className={`portal-hold-outcome is-${result.status}`} role={result.status === 'rechecked' ? 'status' : 'alert'}><strong>{recheckOutcomeTitle(result.status)}</strong><span>{recheckOutcomeMessage(result.status, bookingEnabled)}</span>{priceMove && result.currency === currency && <b>Previously {formatTotal({ currency, amountMinor: priceMove.previousMinor })} · Current price {formatTotal({ currency, amountMinor: priceMove.currentMinor })}{delta ? ` · Difference ${delta}` : ''}</b>}{priceMove?.searchQuoteMinor !== null && priceMove?.searchQuoteMinor !== undefined && <small>Search quote {formatTotal({ currency, amountMinor: priceMove.searchQuoteMinor })}</small>}</div>
}
