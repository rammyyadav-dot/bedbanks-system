'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Bell, ChevronDown, Command, Hotel, Menu, Search, ShieldCheck, UserCircle, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { adminSections, demoSession, demoTenants } from '@/lib/architecture'

const icons: Record<string, string> = { LayoutDashboard: '▦', Building2: '⌂', ShieldCheck: '◈', Hotel: '▣', Network: '⌁', ScrollText: '≡' }

type CommandItem = { label: string; meta: string; type: string; href: string }

const commandItems: CommandItem[] = [
  { label: 'Operations Dashboard', meta: 'Platform · live operations', type: 'PAGE', href: '/admin' },
  { label: 'Tenant directory', meta: 'All tenants · governance', type: 'PAGE', href: '/admin/tenants' },
  { label: 'Hotel master', meta: 'Supply catalog · active', type: 'PAGE', href: '/admin/hotels' },
  { label: 'Audit activity', meta: 'Security events · recent', type: 'PAGE', href: '/admin/audit' },
  { label: 'Atlas Getaways', meta: 'AGT-093 · Gold · Healthy', type: 'TENANT', href: '/admin/tenants' },
  { label: 'Travel Republic', meta: 'TRV-021 · Enterprise · Healthy', type: 'TENANT', href: '/admin/tenants' },
  { label: 'Orchid Hotel Dubai', meta: 'DXB-HTL-00821 · Dubai · Active', type: 'HOTEL', href: '/admin/hotels' },
  { label: 'Atlantis The Palm', meta: 'DXB-HTL-00317 · Dubai · Active', type: 'HOTEL', href: '/admin/hotels' },
  { label: 'Hotelbeds', meta: 'Supplier · 98.7% response health', type: 'SUPPLIER', href: '/admin/distribution' },
  { label: 'WebBeds', meta: 'Supplier · 97.9% response health', type: 'SUPPLIER', href: '/admin/distribution' },
  { label: 'FB-104823', meta: 'Atlas Getaways · Confirmed', type: 'BOOKING', href: '/admin' },
  { label: 'UAE Summer 2026', meta: 'Contract · valid through Sep 30', type: 'CONTRACT', href: '/admin/distribution' },
  { label: 'Open pricing simulator', meta: 'Model sell price and markup', type: 'ACTION', href: '/admin/distribution' },
  { label: 'Open search monitor', meta: 'Inspect supplier latency', type: 'ACTION', href: '/admin/distribution' },
]

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [tenant, setTenant] = useState(demoTenants[0])
  const [tenantOpen, setTenantOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? commandItems.filter((item) => `${item.label} ${item.meta} ${item.type}`.toLowerCase().includes(normalized)) : commandItems.slice(0, 4)
  }, [query])

  const closeCommand = () => { setCommandOpen(false); setQuery(''); setActiveIndex(0) }
  const openCommand = () => { setCommandOpen(true); setQuery(''); setActiveIndex(0) }
  const executeCommand = (item: CommandItem | undefined) => { if (!item) return; closeCommand(); router.push(item.href) }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen((value) => !value); return }
      if (!commandOpen) return
      if (event.key === 'Escape') closeCommand()
      if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((value) => Math.min(value + 1, Math.max(results.length - 1, 0))) }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((value) => Math.max(value - 1, 0)) }
      if (event.key === 'Enter') { event.preventDefault(); executeCommand(results[activeIndex]) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeIndex, commandOpen, results])

  useEffect(() => { if (commandOpen) inputRef.current?.focus() }, [commandOpen])

  const currentLabel = adminSections.find((item) => item.href === pathname)?.label ?? 'Operations Dashboard'

  return (
    <div className={`enterprise-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`enterprise-sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Primary navigation">
        <div className="enterprise-brand"><span className="enterprise-mark"><Hotel size={17} /></span><span className="brand-copy"><strong>bedbank</strong><small>CONTROL PLANE</small></span><button className="sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={17} /></button></div>
        <div className="context-switcher"><button className="context-button" onClick={() => setTenantOpen((value) => !value)} aria-expanded={tenantOpen}><span className="context-avatar">{tenant.name.slice(0, 1)}</span><span className="context-copy"><small>ACTIVE CONTEXT</small><strong>{tenant.name}</strong></span><ChevronDown size={14} /></button>{tenantOpen && <div className="context-menu">{demoTenants.map((item) => <button key={item.id} onClick={() => { setTenant(item); setTenantOpen(false) }}><span>{item.name}</span><small>{item.code}</small></button>)}</div>}</div>
        <div className="shell-caption">ADMIN / EXTRANET</div>
        <nav className="enterprise-nav">{adminSections.map((item) => <Link key={item.href} href={item.href} title={collapsed ? item.label : undefined} onClick={() => setMobileOpen(false)} className={pathname === item.href ? 'active' : ''}><span className="nav-glyph">{icons[item.icon] ?? '•'}</span><span className="nav-label">{item.label}</span>{item.href === '/admin' && <i />}</Link>)}</nav>
        <div className="sidebar-footer"><div className="security-note"><ShieldCheck size={15} /><span><strong>Tenant isolation</strong><small>Policy engine active</small></span></div><div className="session-user"><span className="user-initials">JD</span><span className="session-copy"><strong>{demoSession.user.name}</strong><small>Platform Admin</small></span><button aria-label="User menu"><UserCircle size={16} /></button></div></div>
      </aside>
      <main className="enterprise-main"><header className="enterprise-topbar"><button className="mobile-nav-trigger" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={18} /></button><div className="shell-breadcrumb"><span>Platform</span><b>/</b><strong>{currentLabel}</strong></div><button className="command-trigger" onClick={openCommand}><Search size={14} /><span>Search hotels, bookings, suppliers...</span><kbd><Command size={11} /> K</kbd></button><div className="shell-actions"><span className="production-status"><i /> PRODUCTION</span><button className="top-icon" aria-label="Notifications"><Bell size={16} /><i /></button><button className="top-icon" aria-label="User profile"><UserCircle size={18} /></button><button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>◀</button></div></header>{children}</main>
      {mobileOpen && <button className="shell-overlay" onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" />}
      {commandOpen && <div className="command-backdrop" onClick={closeCommand}><div className="command-dialog" role="dialog" aria-modal="true" aria-label="Command center" onClick={(event) => event.stopPropagation()}><div className="command-input"><Search size={16} /><input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }} placeholder="Search the control plane" aria-label="Search the control plane" /><kbd>ESC</kbd></div><div className="command-section">{results.length > 0 ? <>{!query && <small>QUICK ACCESS</small>}{query && <small>RESULTS · {results.length}</small>}{results.map((item, index) => <button key={`${item.type}-${item.label}`} className={index === activeIndex ? 'selected' : ''} onMouseEnter={() => setActiveIndex(index)} onClick={() => executeCommand(item)}><span className="command-item-icon">{item.type.slice(0, 1)}</span><span className="command-item-copy"><strong>{item.label}</strong><small>{item.meta}</small></span><em>{item.type}</em><span>↵</span></button>)}</> : <div className="command-empty"><strong>No results found for “{query}”</strong><small>Try a hotel name, booking reference, tenant, supplier, or contract ID.</small></div>}</div><div className="command-foot"><span>↑ ↓ Navigate</span><span>Enter Open</span><span>Esc Close</span></div></div></div>}
    </div>
  )
}
