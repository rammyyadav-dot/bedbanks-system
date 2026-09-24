'use client'

import { useState } from 'react'
import { Dashboard } from '@/components/dashboard/agent-dashboard'
import { SearchView } from '@/components/search/agent-search-view'
import { Bookings } from '@/components/booking/agent-bookings'
import { Wallet } from '@/components/finance/agent-wallet'
import { validSearchCriteria } from '@bedbanks/domain/search-offers'
import type { SearchCriteria } from '@bedbanks/domain'
import { ApiHotelService } from '@/services/hotel-service'
import { Bell, CheckCircle2, CircleHelp, FileText, LayoutDashboard, Menu, Search, WalletCards, X } from 'lucide-react'
import type { AgentIdentity } from '@/lib/api-client'
import type { Hotel, HotelSearchResult } from '@/types/hotel'

type View = 'dashboard' | 'search' | 'bookings' | 'wallet'

export function AgentPortal({ identity, tenantId, providerStatus, finance }: { identity: AgentIdentity; tenantId: string; providerStatus: 'idle' | 'checking' | 'available' | 'unavailable'; finance: { status: string; availableCredit: number | null } | null }) {
  const [view, setView] = useState<View>('dashboard')
  const [mobileNav, setMobileNav] = useState(false)
  const [destination, setDestination] = useState('Dubai')
  const [checkIn, setCheckIn] = useState(() => new Date().toISOString().slice(0, 10))
  const [checkOut, setCheckOut] = useState(() => new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10))
  const [rooms, setRooms] = useState(1)
  const [adults, setAdults] = useState(2)
  const [children, setChildren] = useState(0)
  const [childAges, setChildAges] = useState<number[]>([])
  const guests = `${rooms} room${rooms === 1 ? '' : 's'} · ${adults} adult${adults === 1 ? '' : 's'}${children ? ` · ${children} children` : ''}`
  const [selected, setSelected] = useState<Hotel | null>(null)
  const [searchResult, setSearchResult] = useState<HotelSearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [toast, setToast] = useState('')
  const [filter, setFilter] = useState('All')
  const agency = identity.memberships.find((membership) => membership.tenantId === tenantId)?.tenantName ?? 'Verified agency workspace'
  const creditLabel = finance?.availableCredit == null ? 'Not configured' : `USD ${finance.availableCredit.toLocaleString()}`
  const show = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2200) }
  const nav = (next: View) => { setView(next); setMobileNav(false); setSelected(null) }
  const criteria: SearchCriteria = { destination: destination.trim(), checkIn, checkOut, rooms, adults, children, childAges, nationality: 'IN', currency: 'AED' }
  const updateChildren = (count: number) => { setChildren(count); setChildAges((ages) => Array.from({ length: count }, (_, index) => ages[index] ?? 0)) }
  async function handleSearch() {
    if (searching) return
    setSelected(null)
    setSearchResult(null)
    if (!validSearchCriteria(criteria)) {
      show('Enter a destination, valid dates and occupancy')
      return
    }
    setSearching(true)
    try {
      setSearchResult(await new ApiHotelService().search(criteria, tenantId))
    } finally {
      setSearching(false)
    }
  }

  return <div className="portal-shell">
    <header className="portal-header"><button className="portal-mobile-menu" onClick={() => setMobileNav(!mobileNav)} aria-label="Open navigation"><Menu size={20} /></button><button className="portal-brand" onClick={() => nav('dashboard')}><span>f</span><strong>fBeds</strong><small>WHOLESALE TRAVEL</small></button><button className="portal-global-search" onClick={() => nav('search')} aria-label="Open hotel search"><Search size={16} /><span>Open hotel search</span></button><div className="portal-header-actions"><span className={`portal-live ${searchResult?.status === 'available' ? 'is-live' : ''}`}><i /> {searchResult?.status === 'available' ? 'VERIFIED LIVE OFFERS' : providerStatus === 'checking' ? 'VERIFYING WORKSPACE' : providerStatus === 'unavailable' ? 'INVENTORY UNAVAILABLE' : 'SUPPLIER NOT CHECKED'}</span><span className="portal-credit">Credit <strong>{creditLabel}</strong></span><button disabled title="Notifications unavailable" aria-label="Notifications unavailable"><Bell size={17} /></button><button disabled title="Support contact is unavailable" aria-label="Support unavailable"><CircleHelp size={17} /></button><span className="portal-avatar">{(identity.user.name ?? 'JD').slice(0, 2).toUpperCase()}</span></div></header>
    <div className="portal-body"><aside className={`portal-sidebar ${mobileNav ? 'is-open' : ''}`}><div className="portal-sidebar-heading">WORKSPACE <button onClick={() => setMobileNav(false)} aria-label="Close navigation"><X size={16} /></button></div><nav aria-label="Agent portal navigation"><NavItem icon={<LayoutDashboard size={17} />} label="Dashboard" active={view === 'dashboard'} onClick={() => nav('dashboard')} /><NavItem icon={<Search size={17} />} label="Hotel search" active={view === 'search'} onClick={() => nav('search')} /><NavItem icon={<FileText size={17} />} label="My bookings" active={view === 'bookings'} onClick={() => nav('bookings')} /><NavItem icon={<WalletCards size={17} />} label="Wallet & credit" active={view === 'wallet'} onClick={() => nav('wallet')} /></nav><div className="portal-sidebar-footer"><span className="portal-eyebrow">ACTIVE AGENCY</span><strong>{agency}</strong><small>{identity.user.email}</small></div></aside><main className="portal-main"><div className="portal-breadcrumb">fBeds Agent Portal <span>/</span> {view === 'dashboard' ? 'Dashboard' : view === 'search' ? 'Hotel search' : view === 'bookings' ? 'My bookings' : 'Wallet & credit'}</div>{view === 'dashboard' && <Dashboard onSearch={() => nav('search')} onBookings={() => nav('bookings')} agency={agency} userName={identity.user.name ?? identity.user.email} creditLabel={creditLabel} hasFinance={finance?.availableCredit != null} demoEnabled={process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production'} show={show} />}{view === 'search' && <SearchView destination={destination} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut} guests={guests} hotels={searchResult?.hotels ?? []} liveHotels={searchResult?.liveHotels ?? []} result={searchResult} rooms={rooms} setRooms={setRooms} adults={adults} setAdults={setAdults} children={children} updateChildren={updateChildren} childAges={childAges} setChildAges={setChildAges} searching={searching} onSearch={handleSearch} selected={selected} setSelected={setSelected} onCriteriaChange={() => { setSearchResult(null); setSelected(null) }} />}{view === 'bookings' && <Bookings demoEnabled={process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production'} filter={filter} setFilter={setFilter} onSearch={() => nav('search')} />}{view === 'wallet' && <Wallet creditLabel={creditLabel} hasFinance={finance?.availableCredit != null} />}</main></div>{toast && <div className="portal-toast" role="status"><CheckCircle2 size={16} /> {toast}</div>}</div>
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) { return <button className={`portal-nav-item ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{active && <b />}</button> }

