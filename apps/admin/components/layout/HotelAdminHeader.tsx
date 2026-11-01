'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Building2, ChevronDown, ClipboardList, Search } from 'lucide-react'
import { useCan } from '@/lib/auth/capabilities'
import { getHotel360, getHotelsCommercial } from '@/lib/data/hotel-commercial'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { TenantSwitcher } from './TenantSwitcher'
import { ThemeToggle } from './ThemeToggle'
import { LogoutButton } from '@/components/auth/LogoutButton'
import type { AuthenticatedUser } from '@/lib/api/auth-client'
import { navSections } from './nav-config'

/** Native disclosure controls keep all existing, authorized modules reachable. */
export function HotelAdminHeader({ identity, activeTenantId }: { identity: AuthenticatedUser; activeTenantId: string | null }) {
  const pathname = usePathname()
  const can = useCan()
  const hotelId = pathname.match(/^\/hotels\/([^/]+)/)?.[1]
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  const { state, reload } = useOpsQuery(() => getHotelsCommercial({ search: query || undefined, page: 1, pageSize: 25 }), [query])
  const current = useOpsQuery(() => hotelId && hotelId !== 'new' ? getHotel360(hotelId) : Promise.resolve(null), [hotelId])
  const header = useRef<HTMLElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!header.current?.contains(event.target as Node)) header.current?.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open')) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  const selected = current.state.status === 'ready' ? current.state.data?.hotel : undefined
  const base = hotelId && hotelId !== 'new' ? `/hotels/${encodeURIComponent(hotelId)}` : '/hotels'
  function close() { header.current?.querySelectorAll('details[open]').forEach(d => d.removeAttribute('open')) }
  const hotelLinks = [
    { label: 'Property Setup', href: base, visible: can('supply.rooms.read') },
    { label: 'Hotel Profile', href: `${base}?tab=setup`, visible: true },
    { label: 'Full Hotel Management', href: `${base}?tab=overview`, visible: true },
    { label: 'Quick Update', href: `${base}?tab=quick`, visible: can('supply.rates.read') && (can('supply.rates.manage') || can('supply.availability.manage')) },
    { label: 'Rates & Inventory', href: `${base}?tab=rates`, visible: can('supply.rates.read') },
    { label: 'All Hotels', href: '/hotels', visible: true },
  ]
  return <header className="hotel-admin-header" ref={header} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) close() }} onKeyDown={e => {
    if (e.key === 'Escape') {
      const disclosure = (e.target as HTMLElement).closest('details')
      close(); disclosure?.querySelector('summary')?.focus()
    }
  }}>
    <div className="hotel-admin-top">
      <Link href="/dashboard" className="hotel-admin-brand"><span><Building2 size={18} /></span><div><strong>FBEDS</strong><small>HOTEL MANAGEMENT</small></div></Link>
      <span className="hotel-property-label">PROPERTY</span>
      <details name="hotel-admin-menu" className="hotel-property-picker">
        <summary><Search size={13} /><span>{selected?.name ?? (state.status === 'loading' ? 'Loading properties…' : 'Select a property')}</span><ChevronDown size={12} /></summary>
        <div className="hotel-admin-dropdown hotel-property-options">
          <label>Search properties<input type="search" value={search} placeholder="Hotel name or city" onChange={e => setSearch(e.target.value)} /></label>
          {state.status === 'loading' && <p role="status">Loading properties…</p>}
          {state.status === 'failed' && <div role="alert"><p>Properties could not be loaded.</p><button type="button" onClick={reload}>Retry</button></div>}
          {state.status === 'ready' && <div className="hotel-property-results">
            {state.data.items.map(h => <Link key={h.id} prefetch={false} href={`/hotels/${encodeURIComponent(h.id)}`} aria-current={h.id === hotelId ? 'page' : undefined} onClick={() => { close(); setSearch('') }}><Building2 size={13} /><span>{h.name}<small>{h.city}</small></span></Link>)}
            {state.data.items.length === 0 && <p>No properties found.</p>}
          {state.data.total > state.data.items.length && <p>Showing the first 25 matches. Refine your search to find a property.</p>}
          </div>}
        </div>
      </details>
      {can('booking.read') && <Link className="hotel-header-action" href="/bookings"><ClipboardList size={13} />Reservations</Link>}
      <details name="hotel-admin-menu" className="hotel-account"><summary aria-label="User account">{identity.user.name ?? identity.user.email}<ChevronDown size={12} /></summary><div className="hotel-admin-dropdown"><p>{identity.user.email}</p><TenantSwitcher memberships={identity.memberships} activeTenantId={activeTenantId} /><ThemeToggle /><LogoutButton /></div></details>
    </div>
    <nav className="hotel-admin-nav" aria-label="Primary">
      <Link className="hotel-nav-link" href="/dashboard">Dashboard</Link>
      {can('booking.read') && <Link className="hotel-nav-link" href="/bookings">Bookings</Link>}
      {can('supply.hotels.read') && <details name="hotel-admin-menu" className="hotel-management-menu"><summary>Hotel Management<ChevronDown size={12} /></summary><div className="hotel-admin-dropdown">{hotelLinks.filter(l => l.visible).map(l => <Link key={l.label} href={l.href} onClick={close}>{l.label}</Link>)}</div></details>}
      {navSections.map((s, index) => ({ ...s, key: index, items: s.items.filter(i => !['/hotels', '/dashboard', '/bookings'].includes(i.href) && (!i.requires || can(i.requires))) })).filter(s => s.items.length).map(s => <details name="hotel-admin-menu" key={s.key}><summary>{s.label ?? 'Administration'}<ChevronDown size={12} /></summary><div className="hotel-admin-dropdown">{s.items.map(i => <Link href={i.href} key={i.href} onClick={close}>{i.label}</Link>)}</div></details>)}
    </nav>
  </header>
}
