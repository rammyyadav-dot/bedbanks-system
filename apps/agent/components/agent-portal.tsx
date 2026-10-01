'use client'

import { useRef, useState } from 'react'
import { Dashboard } from '@/components/dashboard/agent-dashboard'
import { SearchView } from '@/components/search/agent-search-view'
import { Bookings } from '@/components/booking/agent-bookings'
import { Wallet } from '@/components/finance/agent-wallet'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import type { SearchCriteria } from '@bedbanks/domain'
import { ApiHotelService } from '@/services/hotel-service'
import { Bell, CheckCircle2, CircleHelp, FileText, LayoutDashboard, Menu, Search, WalletCards, X } from 'lucide-react'
import type { AgentIdentity, FinanceSummary } from '@/lib/api-client'
import { creditBreakdown, formatMinorAmount } from '@/lib/format'
import type { HotelSearchResult } from '@/types/hotel'

type View = 'dashboard' | 'search' | 'bookings' | 'wallet'

const SEARCH_PAGE_SIZE = 25

export function AgentPortal({ identity, tenantId, providerStatus, finance, bookingEnabled = false, onFinanceChanged = () => {} }: { identity: AgentIdentity; tenantId: string; providerStatus: 'idle' | 'checking' | 'available' | 'unavailable'; finance: FinanceSummary | null; bookingEnabled?: boolean; onFinanceChanged?: () => void }) {
  const [view, setView] = useState<View>('dashboard')
  const [openBookingId, setOpenBookingId] = useState<string | null>(null)
  const [mobileNav, setMobileNav] = useState(false)
  const [destination, setDestination] = useState('Dubai')
  const [checkIn, setCheckIn] = useState(() => new Date().toISOString().slice(0, 10))
  const [checkOut, setCheckOut] = useState(() => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10))
  const [rooms, setRooms] = useState(1)
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [childAges, setChildAges] = useState<number[]>([])
  const guests = `${rooms} room${rooms === 1 ? '' : 's'} · ${adults} adult${adults === 1 ? '' : 's'}${children ? ` · ${children} children` : ''}`
  const [searchResult, setSearchResult] = useState<HotelSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState('')
  const [toast, setToast] = useState('')
  const searchGeneration = useRef(0)
  const agency = identity.memberships.find((membership) => membership.tenantId === tenantId)?.tenantName ?? 'Verified agency workspace'
  const formattedCredit = formatMinorAmount(finance?.availableCredit, finance?.currency)
  const creditLabel = formattedCredit ?? 'Not configured'
  const show = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2200) }
  const nav = (next: View) => { setView(next); setMobileNav(false) }
  const criteria: SearchCriteria = { destination: destination.trim(), checkIn, checkOut, rooms, adults, children, childAges, nationality: 'IN', currency: 'AED', limit: SEARCH_PAGE_SIZE }
  const updateChildren = (count: number) => { setChildren(count); setChildAges((ages) => Array.from({ length: count }, (_, index) => ages[index] ?? 0)) }
  const stampSearch = (result: HotelSearchResult): HotelSearchResult => {
    const hotelSearchIds: Record<string, string> = {}
    if (result.searchId) for (const hotel of result.liveHotels) hotelSearchIds[hotel.hotelId] = result.searchId
    return { ...result, hotelSearchIds }
  }
  const resetSearch = () => { searchGeneration.current += 1; setSearchResult(null); setLoadMoreError(''); setLoadingMore(false) }
  async function handleSearch() {
    if (searching) return
    const generation = searchGeneration.current + 1
    searchGeneration.current = generation
    setSearchResult(null)
    setLoadMoreError('')
    if (!validSearchCriteria(criteria)) {
      show('Enter a destination, valid dates and occupancy')
      return
    }
    setSearching(true)
    try {
      const result = await new ApiHotelService().search(criteria, tenantId)
      if (generation === searchGeneration.current) setSearchResult(stampSearch(result))
    } catch {
      if (generation === searchGeneration.current) show('Search is temporarily unavailable. Please try again.')
    } finally {
      if (generation === searchGeneration.current) setSearching(false)
    }
  }
  async function handleLoadMore() {
    const current = searchResult
    const nextOffset = current?.pagination?.nextOffset
    if (!current?.pagination?.hasMore || nextOffset === undefined || loadingMore || searching) return
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
      const seen = new Set(current.liveHotels.map((hotel) => hotel.hotelId))
      const added = next.liveHotels.filter((hotel) => !seen.has(hotel.hotelId))
      if (added.length === 0 && next.pagination?.hasMore) {
        setLoadMoreError('Could not load more hotels. Existing results are unchanged.')
        return
      }
      const hotelSearchIds = { ...current.hotelSearchIds }
      if (next.searchId) for (const hotel of added) hotelSearchIds[hotel.hotelId] = next.searchId
      setSearchResult({
        ...current,
        liveHotels: [...current.liveHotels, ...added],
        total: current.liveHotels.length + added.length,
        pagination: next.pagination ?? { ...current.pagination, hasMore: false, nextOffset: undefined },
        hotelSearchIds,
      })
    } catch {
      if (generation === searchGeneration.current) setLoadMoreError('Could not load more hotels. Existing results are unchanged.')
    } finally {
      if (generation === searchGeneration.current) setLoadingMore(false)
    }
  }

  return <div className="portal-shell">
    <header className="portal-header"><button className="portal-mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label={mobileNav ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileNav}><Menu size={20} /></button><button className="portal-brand" onClick={() => nav('dashboard')}><span>f</span><strong>fBeds</strong><small>WHOLESALE TRAVEL</small></button><button className="portal-global-search" onClick={() => nav('search')} aria-label="Open hotel search"><Search size={16} /><span>Open hotel search</span></button><div className="portal-header-actions"><span className={`portal-live ${searchResult?.status === 'available' ? 'is-live' : ''}`}><i /> {searchResult?.status === 'available' ? 'VERIFIED LIVE OFFERS' : providerStatus === 'checking' ? 'VERIFYING WORKSPACE' : providerStatus === 'unavailable' ? 'INVENTORY UNAVAILABLE' : 'SUPPLIER NOT CHECKED'}</span><span className="portal-credit">Credit <strong>{creditLabel}</strong></span><button disabled title="Notifications unavailable" aria-label="Notifications unavailable"><Bell size={17} /></button><button disabled title="Support contact is unavailable" aria-label="Support unavailable"><CircleHelp size={17} /></button><span className="portal-avatar">{(identity.user.name ?? 'JD').slice(0, 2).toUpperCase()}</span></div></header>
    <div className="portal-body"><aside className={`portal-sidebar ${mobileNav ? 'is-open' : ''}`} aria-label="Workspace navigation"><div className="portal-sidebar-heading">WORKSPACE <button onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={16} /></button></div><nav aria-label="Agent portal navigation"><NavItem icon={<LayoutDashboard size={17} />} label="Dashboard" active={view === 'dashboard'} onClick={() => nav('dashboard')} /><NavItem icon={<Search size={17} />} label="Hotel search" active={view === 'search'} onClick={() => nav('search')} /><NavItem icon={<FileText size={17} />} label="My bookings" active={view === 'bookings'} onClick={() => nav('bookings')} /><NavItem icon={<WalletCards size={17} />} label="Wallet & credit" active={view === 'wallet'} onClick={() => nav('wallet')} /></nav><div className="portal-sidebar-footer"><span className="portal-eyebrow">ACTIVE AGENCY</span><strong>{agency}</strong><small>{identity.user.email}</small></div></aside><main className="portal-main"><div className="portal-breadcrumb">fBeds Agent Portal <span>/</span> {view === 'dashboard' ? 'Dashboard' : view === 'search' ? 'Hotel search' : view === 'bookings' ? 'My bookings' : 'Wallet & credit'}</div>{view === 'dashboard' && <Dashboard onSearch={() => nav('search')} onBookings={() => nav('bookings')} agency={agency} userName={identity.user.name ?? identity.user.email} creditLabel={creditLabel} hasFinance={formattedCredit !== null}  />}{view === 'search' && <SearchView destination={destination} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut} guests={guests} liveHotels={searchResult?.liveHotels ?? []} result={searchResult} rooms={rooms} setRooms={setRooms} adults={adults} setAdults={setAdults} children={children} updateChildren={updateChildren} childAges={childAges} setChildAges={setChildAges} searching={searching} loadingMore={loadingMore} loadMoreError={loadMoreError} onSearch={handleSearch} onLoadMore={() => void handleLoadMore()} onCriteriaChange={resetSearch} bookingEnabled={bookingEnabled} tenantId={tenantId} onBooked={onFinanceChanged} onViewBooking={(id) => { setOpenBookingId(id); nav('bookings') }} />}{view === 'bookings' && <Bookings tenantId={tenantId} bookingEnabled={bookingEnabled} initialBookingId={openBookingId} onChanged={onFinanceChanged} onSearch={() => nav('search')} />}{view === 'wallet' && <Wallet creditLabel={creditLabel} creditLimitLabel={creditBreakdown(finance).limit} creditUsedLabel={creditBreakdown(finance).used} hasFinance={formattedCredit !== null} />}</main></div>{toast && <div className="portal-toast" role="status"><CheckCircle2 size={16} /> {toast}</div>}</div>
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) { return <button className={`portal-nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{active && <b />}</button> }
