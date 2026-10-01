'use client'

import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { searchAttemptNotice } from '@/lib/search-notice'
import { SearchView } from '@/components/search/agent-search-view'
import { AgentHome } from '@/components/home/agent-home'
import { Bookings } from '@/components/booking/agent-bookings'
import { Wallet } from '@/components/finance/agent-wallet'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import type { SearchCriteria } from '@bedbanks/domain'
import { ApiHotelService } from '@/services/hotel-service'
import { CheckCircle2, CircleHelp, FileText, House, Menu, Search, WalletCards, X } from 'lucide-react'
import type { AgentIdentity, FinanceSummary } from '@/lib/api-client'
import { creditBreakdown, formatMinorAmount } from '@/lib/format'
import { isGuestMarket, readGuestNationality, rememberGuestNationality } from '@/lib/guest-market'
import { criteriaFilters, minorToWholeAmount, type FilterDraft } from '@/lib/search-filters'
import { resolvedChildAges, type DraftChildAge } from '@/lib/occupancy'
import { defaultSearchStay } from '@/lib/stay-calendar'
import { appendHotelPage } from '@/lib/search-page'
import { beginSearchRun, invalidateSearchRun, settleSearchRun } from '@/lib/search-attempt'
import { rememberRecentSearch, type RecentSearch } from '@/lib/recent-searches'
import type { HotelSearchResult } from '@/types/hotel'

type View = 'home' | 'search' | 'bookings' | 'wallet'
type SearchOverride = Partial<Pick<SearchCriteria, 'destination' | 'checkIn' | 'checkOut' | 'rooms' | 'adults' | 'children' | 'childAges' | 'nationality'>> & {
  starRatings?: number[]
  refundableOnly?: boolean
  minPriceMinor?: number
  maxPriceMinor?: number
}

const SEARCH_PAGE_SIZE = 25
const DISPLAY_CURRENCY = 'AED'

export function AgentPortal({ identity, tenantId, providerStatus, finance, bookingEnabled = false, onFinanceChanged = () => {} }: { identity: AgentIdentity; tenantId: string; providerStatus: 'idle' | 'checking' | 'available' | 'unavailable'; finance: FinanceSummary | null; bookingEnabled?: boolean; onFinanceChanged?: () => void }) {
  const [view, setView] = useState<View>('home')
  const [openBookingId, setOpenBookingId] = useState<string | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [destination, setDestination] = useState('Dubai')
  const [stayDates] = useState(() => defaultSearchStay())
  const [checkIn, setCheckIn] = useState(stayDates.checkIn)
  const [checkOut, setCheckOut] = useState(stayDates.checkOut)
  const [rooms, setRooms] = useState(1)
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [childAges, setChildAges] = useState<DraftChildAge[]>([])
  const [nationality, setNationality] = useState('IN')
  const [starRatings, setStarRatings] = useState<number[]>([])
  const [refundableOnly, setRefundableOnly] = useState(false)
  const [minPriceAed, setMinPriceAed] = useState('')
  const [maxPriceAed, setMaxPriceAed] = useState('')
  const [searchResult, setSearchResult] = useState<HotelSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
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
  const draft = (): FilterDraft => ({ starRatings, refundableOnly, minPriceAed, maxPriceAed })
  const criteriaFrom = (source: { destination: string; checkIn: string; checkOut: string; rooms: number; adults: number; children: number; childAges: DraftChildAge[]; nationality: string }, filters: FilterDraft): { criteria: SearchCriteria } | { error: string } => {
    const parsed = criteriaFilters(filters)
    if (!parsed.ok) return { error: parsed.reason }
    const ages = resolvedChildAges(source.children, source.childAges)
    if (!ages) return { error: 'Choose an age for each child.' }
    return {
      criteria: {
        destination: source.destination.trim(),
        checkIn: source.checkIn,
        checkOut: source.checkOut,
        rooms: source.rooms,
        adults: source.adults,
        children: source.children,
        childAges: ages,
        nationality: source.nationality,
        currency: DISPLAY_CURRENCY,
        limit: SEARCH_PAGE_SIZE,
        ...(parsed.filters ? { filters: parsed.filters } : {}),
      },
    }
  }
  const updateChildren = (count: number) => { setChildren(count); setChildAges((ages) => Array.from({ length: count }, (_, index) => ages[index] ?? null)) }
  const stampSearch = (result: HotelSearchResult): HotelSearchResult => {
    const hotelSearchIds: Record<string, string> = {}
    if (result.searchId) for (const hotel of result.liveHotels) hotelSearchIds[hotel.hotelId] = result.searchId
    return { ...result, hotelSearchIds }
  }
  const resetSearch = () => {
    const next = invalidateSearchRun({ generation: searchGeneration.current, searching: searchingRef.current })
    searchGeneration.current = next.generation
    searchingRef.current = next.searching
    setSearching(false)
    setSearchResult(null)
    setLoadMoreError('')
    setLoadingMore(false)
    setSearchFailed(false)
  }
  const applyOverride = (override?: SearchOverride): { criteria: SearchCriteria } | { error: string } => {
    const nextDestination = override?.destination ?? destination
    const nextCheckIn = override?.checkIn ?? checkIn
    const nextCheckOut = override?.checkOut ?? checkOut
    const nextRooms = override?.rooms ?? rooms
    const nextAdults = override?.adults ?? adults
    const nextChildren = override?.children ?? children
    const nextAges = override?.childAges ?? (override?.children !== undefined ? childAges.slice(0, override.children) : childAges)
    const nextNationality = override?.nationality && isGuestMarket(override.nationality) ? override.nationality : nationality
    const nextStars = override?.starRatings ?? starRatings
    const nextRefundable = override?.refundableOnly ?? refundableOnly
    const nextMin = override && ('minPriceMinor' in override || 'maxPriceMinor' in override) ? minorToWholeAmount(override.minPriceMinor) : minPriceAed
    const nextMax = override && ('minPriceMinor' in override || 'maxPriceMinor' in override) ? minorToWholeAmount(override.maxPriceMinor) : maxPriceAed
    if (override?.destination !== undefined) setDestination(override.destination)
    if (override?.checkIn !== undefined) setCheckIn(override.checkIn)
    if (override?.checkOut !== undefined) setCheckOut(override.checkOut)
    if (override?.rooms !== undefined) setRooms(override.rooms)
    if (override?.adults !== undefined) setAdults(override.adults)
    if (override?.children !== undefined) setChildren(override.children)
    if (override?.childAges !== undefined) setChildAges([...override.childAges])
    else if (override?.children !== undefined) updateChildren(override.children)
    if (override?.nationality && isGuestMarket(override.nationality)) {
      setNationality(override.nationality)
      rememberGuestNationality(window.sessionStorage, identity.user.id, override.nationality)
    }
    if (override && 'starRatings' in override && override.starRatings) setStarRatings(override.starRatings)
    if (override && 'refundableOnly' in override) setRefundableOnly(Boolean(override.refundableOnly))
    if (override && ('minPriceMinor' in override || 'maxPriceMinor' in override)) {
      setMinPriceAed(nextMin)
      setMaxPriceAed(nextMax)
    }
    return criteriaFrom(
      { destination: nextDestination, checkIn: nextCheckIn, checkOut: nextCheckOut, rooms: nextRooms, adults: nextAdults, children: nextChildren, childAges: nextAges, nationality: nextNationality },
      { starRatings: nextStars, refundableOnly: nextRefundable, minPriceAed: nextMin, maxPriceAed: nextMax },
    )
  }
  const changeNationality = (value: string) => {
    setNationality(value)
    rememberGuestNationality(window.sessionStorage, identity.user.id, value)
  }
  async function handleSearch(requested?: SearchCriteria) {
    const built = requested ? { criteria: requested } : criteriaFrom({ destination, checkIn, checkOut, rooms, adults, children, childAges, nationality }, draft())
    if ('error' in built) {
      show(built.error)
      return
    }
    if (!validSearchCriteria(built.criteria)) {
      show('Enter a destination, valid dates and occupancy')
      return
    }
    const started = beginSearchRun({ generation: searchGeneration.current, searching: searchingRef.current })
    if (!started) return
    searchGeneration.current = started.generation
    searchingRef.current = true
    setSearching(true)
    setSearchResult(null)
    setLoadMoreError('')
    setLoadingMore(false)
    dismissToast()
    const generation = started.generation
    try {
      const result = await new ApiHotelService().search(built.criteria, tenantId)
      if (!settleSearchRun({ generation: searchGeneration.current, searching: searchingRef.current }, generation).apply) return
      setSearchResult(stampSearch(result))
      rememberRecentSearch(window.sessionStorage, identity.user.id, {
        destination: built.criteria.destination,
        checkIn: built.criteria.checkIn,
        checkOut: built.criteria.checkOut,
        rooms: built.criteria.rooms,
        adults: built.criteria.adults,
        children: built.criteria.children,
        childAges: built.criteria.childAges ?? [],
        nationality: built.criteria.nationality,
        ...(built.criteria.filters?.starRatings ? { starRatings: built.criteria.filters.starRatings } : {}),
        ...(built.criteria.filters?.refundableOnly ? { refundableOnly: true } : {}),
        ...(built.criteria.filters?.minPriceMinor !== undefined ? { minPriceMinor: built.criteria.filters.minPriceMinor } : {}),
        ...(built.criteria.filters?.maxPriceMinor !== undefined ? { maxPriceMinor: built.criteria.filters.maxPriceMinor } : {}),
      })
      const notice = searchAttemptNotice({ kind: 'resolved', status: result.status })
      setSearchFailed(Boolean(notice))
      if (notice) show(notice)
    } catch {
      if (settleSearchRun({ generation: searchGeneration.current, searching: searchingRef.current }, generation).apply) {
        setSearchFailed(true)
        const notice = searchAttemptNotice({ kind: 'thrown' })
        if (notice) show(notice)
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
    beginSearch({
      destination: search.destination,
      checkIn: search.checkIn,
      checkOut: search.checkOut,
      rooms: search.rooms,
      adults: search.adults,
      children: search.children,
      childAges: search.childAges,
      ...(search.nationality ? { nationality: search.nationality } : {}),
      starRatings: search.starRatings ?? [],
      refundableOnly: Boolean(search.refundableOnly),
      minPriceMinor: search.minPriceMinor,
      maxPriceMinor: search.maxPriceMinor,
    })
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
  const changeCriteria = (action: () => void) => { resetSearch(); action() }
  const marketProps = {
    destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
    rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges,
    nationality, setNationality: changeNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
    minPriceAed, setMinPriceAed, maxPriceAed, setMaxPriceAed, searching, searchFailed,
  }
  const supplierNote = providerStatus === 'checking' ? 'Checking supplier access' : providerStatus === 'unavailable' ? 'Supplier access was not confirmed' : 'Supplier access has not been checked'

  return <div className="portal-shell market-shell">
    <header className="portal-header market-header">
      <button className="portal-mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label={mobileNav ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileNav}><Menu size={20} /></button>
      <button className="portal-brand" onClick={() => nav('home')}><span>f</span><strong>fBeds</strong></button>
      <nav className={`market-nav ${mobileNav ? 'is-open' : ''}`} aria-label="Marketplace">
        <NavItem icon={<House size={16} />} label="Marketplace" active={view === 'home'} onClick={() => nav('home')} />
        <NavItem icon={<Search size={16} />} label="Hotel search" active={view === 'search'} onClick={() => nav('search')} />
        <NavItem icon={<FileText size={16} />} label="Bookings" active={view === 'bookings'} muted={!bookingEnabled} detail={bookingEnabled ? undefined : 'Not enabled'} onClick={() => nav('bookings')} />
        <NavItem icon={<WalletCards size={16} />} label="Wallet" active={view === 'wallet'} onClick={() => nav('wallet')} />
        <a href="/support"><CircleHelp size={16} /> Support</a>
        <button className="market-nav-close" type="button" onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={16} /></button>
      </nav>
      <div className="portal-header-actions market-account-bar">
        <span className="market-currency" title={supplierNote}>{DISPLAY_CURRENCY}</span>
        <a className="portal-header-link" href="/support">Help</a>
        <span className="market-account"><strong>{agentName}</strong><small>{agency}</small></span>
      </div>
    </header>
    <div className="portal-body"><main className="portal-main">
      {view === 'home' && <AgentHome userId={identity.user.id} {...marketProps} onChange={changeCriteria} onSearch={() => beginSearch()} onSearchDubai={() => beginSearch({ destination: 'Dubai' })} onReplay={replaySearch} />}
      {view === 'search' && <SearchView {...marketProps} liveHotels={searchResult?.liveHotels ?? []} result={searchResult} loadingMore={loadingMore} loadMoreError={loadMoreError} onSearch={() => { void handleSearch() }} onLoadMore={() => void handleLoadMore()} onCriteriaChange={resetSearch} bookingEnabled={bookingEnabled} tenantId={tenantId} onBooked={onFinanceChanged} onViewBooking={(id) => { setOpenBookingId(id); nav('bookings') }} />}
      {view === 'bookings' && <Bookings tenantId={tenantId} bookingEnabled={bookingEnabled} initialBookingId={openBookingId} onChanged={onFinanceChanged} onSearch={() => nav('search')} />}
      {view === 'wallet' && <Wallet creditLabel={creditLabel} creditLimitLabel={creditBreakdown(finance).limit} creditUsedLabel={creditBreakdown(finance).used} hasFinance={formattedCredit !== null} />}
    </main></div>
    {toast && <div className="portal-toast" role="status"><CheckCircle2 size={16} /> {toast}</div>}
  </div>
}

function NavItem({ icon, label, active, muted = false, detail, onClick }: { icon: ReactNode; label: string; active: boolean; muted?: boolean; detail?: string; onClick: () => void }) {
  return <button type="button" className={`market-nav-item ${active ? 'active' : ''} ${muted ? 'is-muted' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>{icon}<span>{label}</span>{detail && <small>{detail}</small>}</button>
}
