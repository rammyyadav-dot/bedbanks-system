'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MapPin, Search, ShieldAlert } from 'lucide-react'
import { SearchCriteriaForm } from '@/components/search/search-criteria-form'
import type { DestinationRef, SearchCriteria, SearchHotelOffer, SearchRateOffer, SearchRoomOffer, SearchSort } from '@bedbanks/domain'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import { ApiHotelService } from '@/services/hotel-service'
import { includesBreakfast } from '@/lib/board-basis'
import { marketplaceHome } from '@/lib/marketplace-content'
import { selectableRoomCount, selectableRoomLabel } from '@/lib/room-options'
import { formatCancellationDeadline, formatCompactStay, formatMinorAmount, formatMinorDelta, formatStay } from '@/lib/format'
import { guestMarketName } from '@/lib/guest-market'
import { buildRoomStays, type RoomStayDraft } from '@/lib/occupancy'
import { canSubmitDestination } from '@/lib/destination-suggestions'
import { criteriaFilters, type FilterDraft } from '@/lib/search-filters'
import { activeFilterLabel, stayOccupancyLabel } from '@/lib/search-summary'
import { canOpenCheckout, recheckOutcomeMessage, recheckOutcomeTitle } from '@/lib/recheck-copy'
import { resultWindow } from '@/lib/result-window'
import { BookingReview } from '@/components/booking/booking-review'
import { priceChangeDisplay, recheckBaselineMinor, recheckResultApplies } from '@/lib/recheck-attempt'
import type { HotelSearchResult, OfferRecheckResult } from '@/types/hotel'
import { BookingCheckout } from '@/components/booking/booking-checkout'
import { agencySuspendedMessage, agencySuspendedTitle } from '@/lib/agency-suspension.mjs'

export function SearchView({
  destination, destinationRef, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  liveHotels, result, searching, refreshing = false, refreshError = '', searchFailed, loadingMore, loadMoreError, onSearch, onLoadMore, onPage,
  roomStays, setRoomStays, currency, setCurrency, sort, setSort, onCriteriaChange,
  nationality, setNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
  minPrice, setMinPrice, maxPrice, setMaxPrice, boardBasisIds, setBoardBasisIds, propertyTypes, setPropertyTypes,
  boards, propertyTypeOptions,
  bookingEnabled, tenantId, onBooked, onViewBooking,
}: {
  destination: string; destinationRef: DestinationRef | null; setDestination: (label: string, ref: DestinationRef | null, cityName: string) => void
  checkIn: string; setCheckIn: (value: string) => void
  checkOut: string; setCheckOut: (value: string) => void
  liveHotels: SearchHotelOffer[]
  result: HotelSearchResult | null; searching: boolean; refreshing?: boolean; refreshError?: string; searchFailed: boolean; loadingMore: boolean; loadMoreError: string; onSearch: () => void; onLoadMore: () => void; onPage: (offset: number) => void
  roomStays: RoomStayDraft[]; setRoomStays: (value: RoomStayDraft[]) => void
  currency: string; setCurrency: (value: string) => void
  sort: SearchSort; setSort: (value: SearchSort) => void
  onCriteriaChange: () => void
  nationality: string; setNationality: (value: string) => void
  starRatings: number[]; setStarRatings: (value: number[]) => void
  refundableOnly: boolean; setRefundableOnly: (value: boolean) => void
  minPrice: string; setMinPrice: (value: string) => void
  maxPrice: string; setMaxPrice: (value: string) => void
  boardBasisIds: string[]; setBoardBasisIds: (value: string[]) => void
  propertyTypes: string[]; setPropertyTypes: (value: string[]) => void
  boards: { id: string; name: string }[]; propertyTypeOptions: string[]
  bookingEnabled: boolean; tenantId: string; onBooked: () => void; onViewBooking: (bookingId: string) => void
}) {
  const [selectedLive, setSelectedLive] = useState<SearchHotelOffer | null>(null)
  const [cursor, setCursor] = useState(0)
  const [validationMessage, setValidationMessage] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const draft: FilterDraft = { starRatings, refundableOnly, minPrice, maxPrice, currency, boardBasisIds, propertyTypes }
  const parsedFilters = criteriaFilters(draft)
  const stays = buildRoomStays(roomStays)
  const criteria: SearchCriteria | null = stays.ok && canSubmitDestination(destinationRef) ? {
    destination: destinationRef.type === 'city' ? destination.trim() : destination.trim(), checkIn, checkOut,
    rooms: stays.rooms, adults: stays.adults, children: stays.children, childAges: stays.childAges, roomStays: stays.roomStays,
    destinationRef, nationality, currency, ...(sort !== 'default' ? { sort } : {}),
    ...(destinationRef.type === 'hotel' ? { canonicalHotelIds: [destinationRef.id] } : {}),
    ...(parsedFilters.ok && parsedFilters.filters ? { filters: parsedFilters.filters } : {}),
  } : null
  const update = (action: () => void) => { setValidationMessage(''); onCriteriaChange(); action() }
  const submitSearch = () => {
    if (!canSubmitDestination(destinationRef)) return setValidationMessage('Select a city or hotel. Typed text is not a destination.')
    if (!parsedFilters.ok) return setValidationMessage(parsedFilters.reason)
    if (!stays.ok || !criteria) return setValidationMessage(stays.ok ? 'Choose valid occupancy.' : stays.reason)
    if (!validSearchCriteria(criteria)) return setValidationMessage('Choose valid check-in and check-out dates and at least one adult.')
    setValidationMessage('')
    onSearch()
  }
  const moveCursor = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!liveHotels.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((current) => {
        const next = event.key === 'ArrowDown' ? Math.min(liveHotels.length - 1, current + 1) : Math.max(0, current - 1)
        return next
      })
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const hotel = liveHotels[cursor]
      if (hotel) setSelectedLive(hotel)
    }
  }
  const request = result?.request
  const total = result?.pagination?.total ?? liveHotels.length
  const pageSize = result?.pagination?.limit
  const pageWindow = resultWindow(result?.pagination?.offset ?? 0, liveHotels.length, total)
  return <>
    <SearchCriteriaForm destination={destination} destinationRef={destinationRef} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut} roomStays={roomStays} setRoomStays={setRoomStays} currency={currency} setCurrency={setCurrency} nationality={nationality} setNationality={setNationality} starRatings={starRatings} setStarRatings={setStarRatings} refundableOnly={refundableOnly} setRefundableOnly={setRefundableOnly} minPrice={minPrice} setMinPrice={setMinPrice} maxPrice={maxPrice} setMaxPrice={setMaxPrice} boardBasisIds={boardBasisIds} setBoardBasisIds={setBoardBasisIds} propertyTypes={propertyTypes} setPropertyTypes={setPropertyTypes} boards={boards} propertyTypeOptions={propertyTypeOptions} sort={sort} setSort={setSort} searching={searching} searchFailed={searchFailed} onSubmit={submitSearch} onChange={update} destinationInvalid={Boolean(validationMessage && !canSubmitDestination(destinationRef))} tenantId={tenantId} />
    {validationMessage && <p className="portal-field-error" role="alert">{validationMessage}</p>}
    {searching && !result && <SearchLoadingState />}
    {result && request && <>
      <div className="market-criteria-bar">
        <p>
          <b>{request.destination}</b>
          <b>{formatCompactStay(request.checkIn, request.checkOut)}</b>
          <b>{stayOccupancyLabel(request.rooms, request.adults, request.children, request.childAges)}</b>
          <b>{guestMarketName(request.nationality)}</b>
          <b>{request.currency}</b>
          {request.filters && activeFilterLabel({ ...request.filters, currency: request.currency }) ? <b>{activeFilterLabel({ ...request.filters, currency: request.currency })}</b> : null}
        </p>
        <button className="portal-link" type="button" onClick={() => document.getElementById('hotel-search')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Modify</button>
      </div>
      {refreshing && <p className="market-refresh" role="status">Refreshing results for the new search. The list below is the previous successful search.</p>}
      {refreshError && <p className="portal-field-error" role="alert">{refreshError}</p>}
      <div className="portal-results-meta market-results-bar"><p>{pageWindow.total === 0 ? <>Showing <strong>0</strong> of <strong>0</strong> hotels</> : <>Showing <strong>{pageWindow.start}–{pageWindow.end}</strong> of <strong>{pageWindow.total}</strong> hotels</>}</p><span>{formatStay(request.checkIn, request.checkOut)} · {request.currency}</span>
        <label>Sort<select aria-label="Sort results" value={sort} onChange={(event) => setSort(event.target.value as SearchSort)}><option value="default">Default order</option><option value="price">Total stay</option><option value="stars">Star rating</option><option value="name">Hotel name</option></select></label>
      </div>
      <div className={`portal-status-banner ${result.status === 'empty' ? 'is-empty' : result.status === 'provider_unavailable' || result.status === 'destination_unavailable' ? 'is-error' : ''}`} role="status"><ShieldAlert size={15} /> {statusCopy(result.status)}</div>
      <div className={selectedLive ? 'market-split' : 'market-results'}>
        <div className="portal-hotel-list" data-result-count={liveHotels.length} tabIndex={0} ref={listRef} onKeyDown={moveCursor} aria-label="Hotel results">
          {liveHotels.map((hotel, index) => <LiveHotelCard key={hotel.hotelId} hotel={hotel} active={index === cursor} onSelect={() => { setCursor(index); setSelectedLive(hotel) }} />)}
          {!liveHotels.length && <SearchOutcomeState status={result.status} onRetry={onSearch} onEdit={() => document.getElementById('hotel-search')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />}
          {liveHotels.length > 0 && result.pagination?.hasMore && <div className="portal-load-more"><button className="portal-secondary" type="button" onClick={onLoadMore} disabled={loadingMore || refreshing} aria-busy={loadingMore}>{loadingMore ? 'Loading more hotels…' : pageSize ? `Load ${pageSize} more hotels` : 'Load more hotels'}</button></div>}
          {pageSize && total > pageSize && <PageLinks limit={pageSize} total={total} offset={result.pagination?.offset ?? 0} disabled={loadingMore || refreshing} onPage={onPage} />}
          {loadMoreError && <p className="portal-load-more-error" role="alert">{loadMoreError}</p>}
        </div>
        {selectedLive && <LiveHotelDetail key={selectedLive.hotelId} hotel={selectedLive} request={request} searchId={result.hotelSearchIds?.[selectedLive.hotelId] ?? result.searchId} onBack={() => setSelectedLive(null)} onRefresh={onSearch} bookingEnabled={bookingEnabled} tenantId={tenantId} onBooked={onBooked} onViewBooking={onViewBooking} />}
      </div></>}
  </>
}

function PageLinks({ limit, total, offset, disabled, onPage }: { limit: number; total: number; offset: number; disabled: boolean; onPage: (offset: number) => void }) {
  const pages = Math.ceil(total / limit)
  const current = Math.floor(offset / limit) + 1
  return <nav className="market-pages" aria-label="Result pages">
    <button type="button" disabled={disabled || offset <= 0} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</button>
    {Array.from({ length: pages }, (_, index) => <button key={index} type="button" aria-current={index + 1 === current ? 'page' : undefined} disabled={disabled || index + 1 === current} onClick={() => onPage(index * limit)}>{index + 1}</button>)}
    <button type="button" disabled={disabled || offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</button>
  </nav>
}

function statusCopy(status: HotelSearchResult['status']) {
  if (status === 'available') return marketplaceHome.resultsQuote
  if (status === 'partial') return 'Some hotel inventory is temporarily unavailable. We could not retrieve rates from one inventory source. Your other available results are still shown.'
  if (status === 'mapping_unavailable') return 'Supplier offer mapping could not be verified. No rate is displayed.'
  if (status === 'access_denied') return 'You do not have access to this workspace.'
  if (status === 'agency_suspended') return agencySuspendedMessage
  if (status === 'auth_required') return 'Your session expired. Sign in again.'
  if (status === 'destination_unavailable') return 'This saved destination is no longer in the canonical catalogue.'
  if (status === 'empty') return 'No hotels matched this search. This is not a supplier outage.'
  return 'Search is temporarily unavailable. Please try again.'
}

function SearchLoadingState() {
  return <section className="portal-search-loading" aria-live="polite" aria-busy="true"><div className="portal-search-loading-heading"><span className="portal-spinner" aria-hidden="true" /><div><strong>Searching available hotels…</strong><p>Checking supplier availability and rates</p></div></div><div className="portal-skeleton-list"><span /><span /><span /></div></section>
}
function SearchOutcomeState({ status, onRetry, onEdit }: { status: HotelSearchResult['status']; onRetry: () => void; onEdit: () => void }) {
  if (status === 'agency_suspended') return <div className="portal-empty portal-outcome" role="alert" data-testid="agency-suspended"><Search size={20} /><h2>{agencySuspendedTitle}</h2><p>{agencySuspendedMessage}</p></div>
  const unavailable = ['provider_unavailable', 'auth_required', 'access_denied', 'destination_unavailable'].includes(status)
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
function cancellationDeadline(rate: SearchRateOffer, timeZone?: string) {
  if (!rate.cancellation.deadline || !rate.cancellation.refundable) return null
  return formatCancellationDeadline(rate.cancellation.deadline, timeZone || 'UTC')
}
function cancellationLine(rate: SearchRateOffer, timeZone?: string) {
  const until = cancellationDeadline(rate, timeZone)
  if (until) return `Free cancellation until ${until}`
  return rate.cancellation.summary.trim() || (rate.cancellation.refundable ? 'Refundable' : 'Non-refundable')
}
function moneyLine(label: string, amountMinor: number, currency: string) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null
  const formatted = formatMinorAmount(amountMinor, currency)
  return formatted ? `${label} ${formatted}` : null
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
function LiveHotelCard({ hotel, active, onSelect }: { hotel: SearchHotelOffer; active: boolean; onSelect: () => void }) {
  const lead = leadStay(hotel)
  const rate = lead?.rate
  const roomOptions = selectableRoomLabel(selectableRoomCount(hotel.rooms))
  const deadline = rate ? cancellationDeadline(rate, hotel.timeZone) : null
  return <article className={`portal-hotel-card market-hotel-card market-stay-card${active ? ' is-active' : ''}`}>
    <div className="market-hotel-mark" aria-hidden="true">{hotelInitial(hotel.name)}</div>
    <div className="market-stay-body">
      <div className="market-stay-copy">
        <div className="market-stay-name"><h2>{hotel.name}</h2><StarMark rating={hotel.starRating} /></div>
        <p className="market-stay-place"><MapPin size={14} /> {hotel.destination}{hotel.propertyType ? ` · ${hotel.propertyType}` : ''}</p>
        {hotel.address && <p className="market-stay-address">{hotel.address}</p>}
        {lead && <p className="market-stay-room">{lead.room.name}</p>}
        {rate && <p className="market-stay-facts">{stayOccupancyLabel(rate.occupancy.rooms, rate.occupancy.adults, rate.occupancy.children, rate.occupancy.childAges)} · {cancellationLine(rate, hotel.timeZone)} · {rate.boardBasisName}</p>}
        {rate && <div className="market-badges">{deadline && <span className="is-cancel">Free cancellation until {deadline}</span>}{includesBreakfast(rate.boardBasisName) && <span className="is-meal">Breakfast included</span>}{rate.availability === 'limited' && <span>Limited availability</span>}</div>}
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
  const reviewMinor = selection && recheck?.status === 'rechecked'
    ? (recheck.currency === selection.rate.total.currency && recheck.sellAmountMinor !== undefined ? recheck.sellAmountMinor : baselineMinor)
    : null
  return <section className="portal-detail market-hotel-detail"><button className="portal-link back-link" onClick={onBack}>← Back to results</button>
    <div className="market-detail-head"><div className="market-hotel-mark" aria-hidden="true">{hotelInitial(hotel.name)}</div><div><div className="market-stay-name"><h2>{hotel.name}</h2><StarMark rating={hotel.starRating} /></div><p>{hotel.destination}{hotel.propertyType ? ` · ${hotel.propertyType}` : ''}{hotel.address ? ` · ${hotel.address}` : ''} · {formatStay(request.checkIn, request.checkOut)} · {stayOccupancyLabel(request.rooms, request.adults, request.children, request.childAges)} · {guestMarketName(request.nationality)} · {request.currency}</p></div></div>
    {hotel.rooms.map((room) => <div className="market-room-group" key={room.roomTypeId}><header><h3>{room.name}</h3><span>{room.rates.length} {room.rates.length === 1 ? 'rate' : 'rates'}</span></header><div>{room.rates.map((rate) => {
      const expired = Date.parse(rate.expiresAt) <= now
      const selectable = !expired && rate.availability !== 'sold_out'
      const selected = selection?.rate.offerId === rate.offerId
      const components = [moneyLine('taxes', rate.taxAmountMinor, rate.total.currency), moneyLine('fees', rate.feeAmountMinor, rate.total.currency)].filter(Boolean).join(' · ')
      return <div key={rate.offerId} className={`market-rate-row${selected ? ' is-selected' : ''}`}><div className="market-rate-plan"><strong>{rate.ratePlanName}</strong><span>{rate.boardBasisName}</span>{includesBreakfast(rate.boardBasisName) && <em>Breakfast included</em>}</div><div className="market-rate-policy"><span>{cancellationLine(rate, hotel.timeZone)}</span><span>{stayOccupancyLabel(rate.occupancy.rooms, rate.occupancy.adults, rate.occupancy.children, rate.occupancy.childAges)} · {rate.availability === 'limited' ? 'Limited availability' : rate.availability.replace('_', ' ')} · {paymentLabel(rate.paymentType)}</span></div><div className="market-rate-price"><b>{formatTotal(rate.total)}</b><small>Total stay{components ? ` · ${components}` : ''}</small></div><button className="portal-primary" type="button" disabled={!selectable || (selected && rechecking)} onClick={() => choose(room, rate)}>{expired ? 'Rate expired' : rate.availability === 'sold_out' ? 'Unavailable' : 'Select Offer'}</button></div>
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
      {selection && reviewMinor !== null && <BookingReview hotelName={hotel.name} destination={hotel.destination} starRating={hotel.starRating} roomName={selection.room.name} rate={selection.rate} request={request} recheckedMinor={reviewMinor} bookingEnabled={bookingEnabled} />}
      {canOpenCheckout(bookingEnabled, recheck?.status) && searchId && <BookingCheckout key={selection.rate.offerId} tenantId={tenantId} hotelName={hotel.name} roomName={selection.room.name} rate={selection.rate} searchId={searchId} request={request} onBooked={onBooked} onViewBooking={onViewBooking} />}</div>}
  </section>
}

function RecheckOutcome({ result, currency, priceMove, bookingEnabled }: { result: OfferRecheckResult; currency: string; priceMove: { previousMinor: number; currentMinor: number; searchQuoteMinor: number | null } | null; bookingEnabled: boolean }) {
  const delta = priceMove && result.currency === currency ? formatMinorDelta(priceMove.previousMinor, priceMove.currentMinor, currency) : null
  return <div className={`portal-hold-outcome is-${result.status}`} role={result.status === 'rechecked' ? 'status' : 'alert'}><strong>{recheckOutcomeTitle(result.status)}</strong><span>{recheckOutcomeMessage(result.status, bookingEnabled)}</span>{priceMove && result.currency === currency && <b>Previously {formatTotal({ currency, amountMinor: priceMove.previousMinor })} · Current price {formatTotal({ currency, amountMinor: priceMove.currentMinor })}{delta ? ` · Difference ${delta}` : ''}</b>}{priceMove?.searchQuoteMinor !== null && priceMove?.searchQuoteMinor !== undefined && <small>Search quote {formatTotal({ currency, amountMinor: priceMove.searchQuoteMinor })}</small>}</div>
}
