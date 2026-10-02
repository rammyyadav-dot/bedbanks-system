'use client'

import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { searchAttemptNotice } from '@/lib/search-notice'
import { SearchView } from '@/components/search/agent-search-view'
import { AgentHome } from '@/components/home/agent-home'
import { Bookings } from '@/components/booking/agent-bookings'
import { AgentAccount } from '@/components/account/agent-account'
import { Wallet } from '@/components/finance/agent-wallet'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import type { DestinationRef, SearchCriteria, SearchSort } from '@bedbanks/domain'
import { ApiHotelService } from '@/services/hotel-service'
import { CheckCircle2, CircleHelp, FileText, House, Menu, Search, UserRound, WalletCards, X } from 'lucide-react'
import type { AgentIdentity, FinanceSummary } from '@/lib/api-client'
import { creditBreakdown, formatMinorAmount } from '@/lib/format'
import { isGuestMarket, readGuestNationality, rememberGuestNationality } from '@/lib/guest-market'
import { criteriaFilters, minorToMajorInput, type FilterDraft } from '@/lib/search-filters'
import { buildRoomStays, defaultRoomStay, type RoomStayDraft } from '@/lib/occupancy'
import { canSubmitDestination } from '@/lib/destination-suggestions'
import { fetchDestinations, fetchFacets, type SearchFacets } from '@/lib/destination-client'
import { defaultSearchStay } from '@/lib/stay-calendar'
import { appendHotelPage } from '@/lib/search-page'
import { beginSearchRun, invalidateSearchRun, settleSearchRun } from '@/lib/search-attempt'
import { replaceSearchResult } from '@/lib/search-refresh'
import { canReplayRecentSearch, rememberRecentSearch, type RecentSearch } from '@/lib/recent-searches'
import type { HotelSearchResult } from '@/types/hotel'

type View = 'home' | 'search' | 'bookings' | 'wallet' | 'account'
type SearchOverride = {
  destinationLabel?: string
  destinationCity?: string
  destinationRef?: DestinationRef | null
  checkIn?: string
  checkOut?: string
  roomStays?: RoomStayDraft[]
  nationality?: string
  currency?: string
  sort?: SearchSort
  starRatings?: number[]
  refundableOnly?: boolean
  minPriceMinor?: number
  maxPriceMinor?: number
  boardBasisIds?: string[]
  propertyTypes?: string[]
}

const SEARCH_PAGE_SIZE = 25

export function AgentPortal({ identity, tenantId, providerStatus, finance, bookingEnabled = false, onFinanceChanged = () => {} }: { identity: AgentIdentity; tenantId: string; providerStatus: 'idle' | 'checking' | 'available' | 'unavailable'; finance: FinanceSummary | null; bookingEnabled?: boolean; onFinanceChanged?: () => void }) {
  const [view, setView] = useState<View>('home')
  const [openBookingId, setOpenBookingId] = useState<string | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [destination, setDestinationLabel] = useState('')
  const [destinationCity, setDestinationCity] = useState('')
  const [destinationRef, setDestinationRef] = useState<DestinationRef | null>(null)
  const [stayDates] = useState(() => defaultSearchStay())
  const [checkIn, setCheckIn] = useState(stayDates.checkIn)
  const [checkOut, setCheckOut] = useState(stayDates.checkOut)
  const [roomStays, setRoomStays] = useState<RoomStayDraft[]>([defaultRoomStay()])
  const [nationality, setNationality] = useState('IN')
  const [currency, setCurrency] = useState('AED')
  const [sort, setSort] = useState<SearchSort>('default')
  const [starRatings, setStarRatings] = useState<number[]>([])
  const [refundableOnly, setRefundableOnly] = useState(false)
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [boardBasisIds, setBoardBasisIds] = useState<string[]>([])
  const [propertyTypes, setPropertyTypes] = useState<string[]>([])
  const [facets, setFacets] = useState<SearchFacets>({ boards: [], propertyTypes: [] })
  const [searchResult, setSearchResult] = useState<HotelSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [searchFailed, setSearchFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState('')
  const [toast, setToast] = useState('')
  const searchGeneration = useRef(0)
  const searchingRef = useRef(false)
  const toastTimer = useRef<number | null>(null)
  const agency = identity.memberships.find((membership) => membership.tenantId === tenantId)?.tenantName ?? 'Verified agency workspace'
  const agentName = identity.user.name ?? identity.user.email
  const formattedCredit = formatMinorAmount(finance?.availableCredit, finance?.currency)
  const creditLabel = formattedCredit ?? 'Not configured'
  useEffect(() => {
    const saved = readGuestNationality(window.sessionStorage, identity.user.id)
    if (saved) setNationality(saved)
  }, [identity.user.id])
  useEffect(() => { void fetchFacets(tenantId).then(setFacets) }, [tenantId])
  const dismissToast = () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = null
    setToast('')
  }
  const show = (message: string) => {
    dismissToast()
    setToast(message)
    toastTimer.current = window.setTimeout(() => { toastTimer.current = null; setToast('') }, 2200)
  }
  const nav = (next: View) => { setView(next); setMobileNav(false) }
  const draft = (): FilterDraft => ({ starRatings, refundableOnly, minPrice, maxPrice, currency, boardBasisIds, propertyTypes })
  const selectDestination = (label: string, ref: DestinationRef | null, cityName: string) => {
    setDestinationLabel(label)
    setDestinationRef(ref)
    setDestinationCity(cityName)
  }
  const criteriaFrom = (source: { destinationCity: string; destinationRef: DestinationRef | null; checkIn: string; checkOut: string; roomStays: RoomStayDraft[]; nationality: string; currency: string; sort: SearchSort }, filters: FilterDraft): { criteria: SearchCriteria } | { error: string } => {
    if (!canSubmitDestination(source.destinationRef)) return { error: 'Select a city or hotel. Typed text is not a destination.' }
    const stays = buildRoomStays(source.roomStays)
    if (!stays.ok) return { error: stays.reason }
    const parsed = criteriaFilters(filters)
    if (!parsed.ok) return { error: parsed.reason }
    return {
      criteria: {
        destination: source.destinationCity.trim(),
        destinationRef: source.destinationRef,
        ...(source.destinationRef.type === 'hotel' ? { canonicalHotelIds: [source.destinationRef.id] } : {}),
        checkIn: source.checkIn,
        checkOut: source.checkOut,
        rooms: stays.rooms,
        adults: stays.adults,
        children: stays.children,
        childAges: stays.childAges,
        roomStays: stays.roomStays,
        nationality: source.nationality,
        currency: source.currency,
        limit: SEARCH_PAGE_SIZE,
        ...(source.sort !== 'default' ? { sort: source.sort } : {}),
        ...(parsed.filters ? { filters: parsed.filters } : {}),
      },
    }
  }
  const stampSearch = (result: HotelSearchResult): HotelSearchResult => {
    const hotelSearchIds: Record<string, string> = {}
    if (result.searchId) for (const hotel of result.liveHotels) hotelSearchIds[hotel.hotelId] = result.searchId
    return { ...result, hotelSearchIds }
  }
  const noteCriteriaEdit = () => {
    const next = invalidateSearchRun({ generation: searchGeneration.current, searching: searchingRef.current })
    searchGeneration.current = next.generation
    searchingRef.current = false
    setSearching(false)
    setLoadingMore(false)
  }
  const applyOverride = (override?: SearchOverride): { criteria: SearchCriteria } | { error: string } => {
    const nextLabel = override?.destinationLabel ?? destination
    const nextCity = override?.destinationCity ?? destinationCity
    const nextRef = override && 'destinationRef' in override ? override.destinationRef ?? null : destinationRef
    const nextCheckIn = override?.checkIn ?? checkIn
    const nextCheckOut = override?.checkOut ?? checkOut
    const nextStays = override?.roomStays ?? roomStays
    const nextNationality = override?.nationality && isGuestMarket(override.nationality) ? override.nationality : nationality
    const nextCurrency = override?.currency ?? currency
    const nextSort = override?.sort ?? sort
    const nextStars = override?.starRatings ?? starRatings
    const nextRefundable = override?.refundableOnly ?? refundableOnly
    const nextBoards = override?.boardBasisIds ?? boardBasisIds
    const nextTypes = override?.propertyTypes ?? propertyTypes
    const nextMin = override && ('minPriceMinor' in override || 'maxPriceMinor' in override) ? minorToMajorInput(override.minPriceMinor, nextCurrency) : minPrice
    const nextMax = override && ('minPriceMinor' in override || 'maxPriceMinor' in override) ? minorToMajorInput(override.maxPriceMinor, nextCurrency) : maxPrice
    if (override && ('destinationLabel' in override || 'destinationRef' in override || 'destinationCity' in override)) selectDestination(nextLabel, nextRef, nextCity)
    if (override?.checkIn !== undefined) setCheckIn(override.checkIn)
    if (override?.checkOut !== undefined) setCheckOut(override.checkOut)
    if (override?.roomStays) setRoomStays(override.roomStays.map((stay) => ({ adults: stay.adults, childAges: stay.childAges.map((age) => age ?? null) })))
    if (override?.currency) setCurrency(override.currency)
    if (override?.sort) setSort(override.sort)
    if (override?.nationality && isGuestMarket(override.nationality)) {
      setNationality(override.nationality)
      rememberGuestNationality(window.sessionStorage, identity.user.id, override.nationality)
    }
    if (override && 'starRatings' in override && override.starRatings) setStarRatings(override.starRatings)
    if (override && 'refundableOnly' in override) setRefundableOnly(Boolean(override.refundableOnly))
    if (override?.boardBasisIds) setBoardBasisIds(override.boardBasisIds)
    if (override?.propertyTypes) setPropertyTypes(override.propertyTypes)
    if (override && ('minPriceMinor' in override || 'maxPriceMinor' in override)) {
      setMinPrice(nextMin)
      setMaxPrice(nextMax)
    }
    return criteriaFrom(
      { destinationCity: nextCity, destinationRef: nextRef, checkIn: nextCheckIn, checkOut: nextCheckOut, roomStays: nextStays, nationality: nextNationality, currency: nextCurrency, sort: nextSort },
      { starRatings: nextStars, refundableOnly: nextRefundable, minPrice: nextMin, maxPrice: nextMax, currency: nextCurrency, boardBasisIds: nextBoards, propertyTypes: nextTypes },
    )
  }
  const changeNationality = (value: string) => {
    setNationality(value)
    rememberGuestNationality(window.sessionStorage, identity.user.id, value)
  }
  const requestFailure = (result: HotelSearchResult) => result.status === 'provider_unavailable' || result.status === 'auth_required' || result.status === 'access_denied' || result.status === 'destination_unavailable'
  async function handleSearch(requested?: SearchCriteria) {
    const built = requested ? { criteria: requested } : criteriaFrom({ destinationCity, destinationRef, checkIn, checkOut, roomStays, nationality, currency, sort }, draft())
    if ('error' in built) {
      show(built.error)
      return
    }
    if (!validSearchCriteria(built.criteria)) {
      show('Select a canonical destination, valid dates and occupancy')
      return
    }
    const started = beginSearchRun({ generation: searchGeneration.current, searching: searchingRef.current })
    if (!started) return
    searchGeneration.current = started.generation
    searchingRef.current = true
    const previous = searchResult
    setSearching(true)
    setRefreshError('')
    setLoadMoreError('')
    setLoadingMore(false)
    dismissToast()
    const generation = started.generation
    try {
      const result = await new ApiHotelService().search(built.criteria, tenantId)
      if (!settleSearchRun({ generation: searchGeneration.current, searching: searchingRef.current }, generation).apply) return
      if (!replaceSearchResult(previous !== null, result.status)) {
        setSearchFailed(true)
        setRefreshError(result.failureMessage || 'This search failed. The hotels below are still the previous successful search.')
        return
      }
      setSearchResult(stampSearch(result))
      setRefreshError('')
      rememberRecentSearch(window.sessionStorage, identity.user.id, {
        destination: destination || built.criteria.destination,
        cityName: built.criteria.destination,
        destinationRef: built.criteria.destinationRef,
        checkIn: built.criteria.checkIn,
        checkOut: built.criteria.checkOut,
        rooms: built.criteria.rooms,
        adults: built.criteria.adults,
        children: built.criteria.children,
        childAges: built.criteria.childAges ?? [],
        roomStays: built.criteria.roomStays,
        nationality: built.criteria.nationality,
        currency: built.criteria.currency,
        ...(built.criteria.sort ? { sort: built.criteria.sort } : {}),
        ...(built.criteria.filters?.starRatings ? { starRatings: built.criteria.filters.starRatings } : {}),
        ...(built.criteria.filters?.refundableOnly ? { refundableOnly: true } : {}),
        ...(built.criteria.filters?.minPriceMinor !== undefined ? { minPriceMinor: built.criteria.filters.minPriceMinor } : {}),
        ...(built.criteria.filters?.maxPriceMinor !== undefined ? { maxPriceMinor: built.criteria.filters.maxPriceMinor } : {}),
        ...(built.criteria.filters?.boardBasisIds ? { boardBasisIds: built.criteria.filters.boardBasisIds } : {}),
        ...(built.criteria.filters?.propertyTypes ? { propertyTypes: built.criteria.filters.propertyTypes } : {}),
      })
      const notice = searchAttemptNotice({ kind: 'resolved', status: result.status })
      setSearchFailed(Boolean(notice))
      if (notice) show(notice)
    } catch {
      if (settleSearchRun({ generation: searchGeneration.current, searching: searchingRef.current }, generation).apply) {
        setSearchFailed(true)
        if (previous) setRefreshError('This search failed. The hotels below are still the previous successful search.')
        else {
          const notice = searchAttemptNotice({ kind: 'thrown' })
          if (notice) show(notice)
        }
      }
    } finally {
      const settled = settleSearchRun({ generation: searchGeneration.current, searching: searchingRef.current }, generation)
      if (settled.apply) {
        searchingRef.current = false
        setSearching(false)
      }
    }
  }
  function beginSearch(override?: SearchOverride) {
    const built = applyOverride(override)
    if ('error' in built) {
      show(built.error)
      return
    }
    if (!validSearchCriteria(built.criteria)) {
      show('Enter a destination, valid dates and occupancy')
      return
    }
    setView('search')
    void handleSearch(built.criteria)
  }
  function replaySearch(search: RecentSearch) {
    if (!canReplayRecentSearch(search) || !search.destinationRef || !search.roomStays || !search.currency) {
      show('This saved search can no longer be replayed because its canonical destination is missing.')
      return
    }
    beginSearch({
      destinationLabel: search.destination,
      destinationCity: search.destinationRef.type === 'city' ? search.destination : search.cityName ?? '',
      destinationRef: search.destinationRef,
      checkIn: search.checkIn,
      checkOut: search.checkOut,
      roomStays: search.roomStays.map((stay) => ({ adults: stay.adults, childAges: stay.children.map((child) => child.age) })),
      ...(search.nationality ? { nationality: search.nationality } : {}),
      currency: search.currency,
      ...(search.sort ? { sort: search.sort } : {}),
      starRatings: search.starRatings ?? [],
      refundableOnly: Boolean(search.refundableOnly),
      minPriceMinor: search.minPriceMinor,
      maxPriceMinor: search.maxPriceMinor,
      boardBasisIds: search.boardBasisIds ?? [],
      propertyTypes: search.propertyTypes ?? [],
    })
  }
  async function searchDubai() {
    const results = await fetchDestinations('Dubai', tenantId)
    const city = results.find((item) => item.type === 'city' && item.id === 'city:AE:dubai') ?? results.find((item) => item.type === 'city' && item.countryCode === 'AE' && item.name.toLocaleLowerCase('en-US') === 'dubai')
    if (!city || city.type !== 'city') {
      show('Dubai is not available from the canonical catalogue for this workspace.')
      return
    }
    beginSearch({ destinationLabel: city.name, destinationCity: city.name, destinationRef: { type: 'city', id: city.id, countryCode: city.countryCode } })
  }
  async function handlePage(offset: number) {
    const current = searchResult
    if (!current || offset < 0 || loadingMore || searchingRef.current) return
    const generation = searchGeneration.current
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      const next = await new ApiHotelService().search({ ...current.request, limit: SEARCH_PAGE_SIZE, offset }, tenantId)
      if (generation !== searchGeneration.current) return
      if (requestFailure(next) || next.status === 'mapping_unavailable') {
        setLoadMoreError('Could not open that page. Existing results are unchanged.')
        return
      }
      const hotelSearchIds: Record<string, string> = {}
      if (next.searchId) for (const hotel of next.liveHotels) hotelSearchIds[hotel.hotelId] = next.searchId
      setSearchResult({ ...next, hotelSearchIds, request: current.request })
    } catch {
      if (generation === searchGeneration.current) setLoadMoreError('Could not open that page. Existing results are unchanged.')
    } finally {
      if (generation === searchGeneration.current) setLoadingMore(false)
    }
  }
  async function handleLoadMore() {
    const current = searchResult
    const nextOffset = current?.pagination?.nextOffset
    if (!current?.pagination?.hasMore || nextOffset === undefined || loadingMore || searchingRef.current) return
    const generation = searchGeneration.current
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      const next = await new ApiHotelService().search({ ...current.request, limit: SEARCH_PAGE_SIZE, offset: nextOffset }, tenantId)
      if (generation !== searchGeneration.current) return
      if (!['available', 'partial', 'empty'].includes(next.status)) {
        setLoadMoreError('Could not load more hotels. Existing results are unchanged.')
        return
      }
      const { hotels: mergedHotels, added } = appendHotelPage(current.liveHotels, next.liveHotels)
      if (added.length === 0 && next.pagination?.hasMore) {
        setLoadMoreError('Could not load more hotels. Existing results are unchanged.')
        return
      }
      const hotelSearchIds = { ...current.hotelSearchIds }
      if (next.searchId) for (const hotel of added) hotelSearchIds[hotel.hotelId] = next.searchId
      setSearchResult({
        ...current,
        liveHotels: mergedHotels,
        total: mergedHotels.length,
        pagination: next.pagination ?? { ...current.pagination, hasMore: false, nextOffset: undefined },
        hotelSearchIds,
      })
    } catch {
      if (generation === searchGeneration.current) setLoadMoreError('Could not load more hotels. Existing results are unchanged.')
    } finally {
      if (generation === searchGeneration.current) setLoadingMore(false)
    }
  }
  const applySort = (next: SearchSort) => {
    setSort(next)
    if (!searchResult || !canSubmitDestination(destinationRef)) return
    const built = criteriaFrom({ destinationCity, destinationRef, checkIn, checkOut, roomStays, nationality, currency, sort: next }, draft())
    if ('error' in built) { show(built.error); return }
    void handleSearch(built.criteria)
  }
  const changeCriteria = (action: () => void) => { noteCriteriaEdit(); action() }
  const marketProps = {
    destination, destinationRef, setDestination: selectDestination, checkIn, setCheckIn, checkOut, setCheckOut,
    roomStays, setRoomStays, currency, setCurrency, sort, setSort: applySort,
    nationality, setNationality: changeNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
    minPrice, setMinPrice, maxPrice, setMaxPrice, boardBasisIds, setBoardBasisIds, propertyTypes, setPropertyTypes,
    boards: facets.boards, propertyTypeOptions: facets.propertyTypes, searching, searchFailed, tenantId,
  }
  const supplierNote = providerStatus === 'checking' ? 'Checking supplier access' : providerStatus === 'unavailable' ? 'Supplier access was not confirmed' : 'This status is not a live supplier probe'

  return <div className="portal-shell market-shell">
    <header className="portal-header market-header">
      <button className="portal-mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label={mobileNav ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileNav}><Menu size={20} /></button>
      <button className="portal-brand" onClick={() => nav('home')}><span>f</span><strong>fBeds</strong></button>
      <nav className={`market-nav ${mobileNav ? 'is-open' : ''}`} aria-label="Marketplace">
        <NavItem icon={<House size={16} />} label="Home" active={view === 'home'} onClick={() => nav('home')} />
        <NavItem icon={<Search size={16} />} label="Hotel search" active={view === 'search'} onClick={() => nav('search')} />
        <NavItem icon={<FileText size={16} />} label="My bookings" active={view === 'bookings'} muted={!bookingEnabled} detail={bookingEnabled ? undefined : 'Not enabled'} onClick={() => nav('bookings')} />
        <NavItem icon={<WalletCards size={16} />} label="Wallet" active={view === 'wallet'} onClick={() => nav('wallet')} />
        <NavItem icon={<UserRound size={16} />} label="Account" active={view === 'account'} onClick={() => nav('account')} />
        <a href="/support"><CircleHelp size={16} /> Support</a>
        <button className="market-nav-close" type="button" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={16} /></button>
      </nav>
      <div className="portal-header-actions market-account-bar">
        <span className="market-currency" title={supplierNote}>{currency}</span>
        <a className="portal-header-link" href="/support">Help</a>
        <span className="market-account"><strong>{agentName}</strong><small>{agency}</small></span>
      </div>
    </header>
    <div className="portal-body"><main className="portal-main">
      {view === 'home' && <AgentHome userId={identity.user.id} {...marketProps} bookingEnabled={bookingEnabled} onOpenBookings={() => nav('bookings')} onChange={changeCriteria} onSearch={() => beginSearch()} onSearchDubai={() => { void searchDubai() }} onReplay={replaySearch} />}
      {view === 'search' && <SearchView {...marketProps} liveHotels={searchResult?.liveHotels ?? []} result={searchResult} refreshing={searching && searchResult !== null} refreshError={refreshError} loadingMore={loadingMore} loadMoreError={loadMoreError} onSearch={() => { void handleSearch() }} onLoadMore={() => void handleLoadMore()} onPage={(offset) => void handlePage(offset)} onCriteriaChange={noteCriteriaEdit} bookingEnabled={bookingEnabled} tenantId={tenantId} onBooked={onFinanceChanged} onViewBooking={(id) => { setOpenBookingId(id); nav('bookings') }} />}
      {view === 'bookings' && <Bookings tenantId={tenantId} bookingEnabled={bookingEnabled} initialBookingId={openBookingId} onChanged={onFinanceChanged} onSearch={() => nav('search')} />}
      {view === 'wallet' && <Wallet creditLabel={creditLabel} creditLimitLabel={creditBreakdown(finance).limit} creditUsedLabel={creditBreakdown(finance).used} hasFinance={formattedCredit !== null} />}
      {view === 'account' && <AgentAccount identity={identity} tenantId={tenantId} />}
    </main></div>
    {toast && <div className="portal-toast" role="status"><CheckCircle2 size={16} /> {toast}</div>}
  </div>
}

function NavItem({ icon, label, active, muted = false, detail, onClick }: { icon: ReactNode; label: string; active: boolean; muted?: boolean; detail?: string; onClick: () => void }) {
  return <button type="button" className={`market-nav-item ${active ? 'active' : ''} ${muted ? 'is-muted' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>{icon}<span>{label}</span>{detail && <small>{detail}</small>}</button>
}
