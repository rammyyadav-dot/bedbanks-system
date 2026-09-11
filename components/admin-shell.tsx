'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Bell, ChevronDown, Command, Hotel, Menu, Search, ShieldCheck, UserCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { adminSections, demoSession, demoTenants } from '@/lib/architecture'

const icons: Record<string, string> = { LayoutDashboard: '▦', Building2: '⌂', ShieldCheck: '◈', Hotel: '▣', Network: '⌁', ScrollText: '≡' }

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [tenant, setTenant] = useState(demoTenants[0])
  const [tenantOpen, setTenantOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setCommandOpen((value) => !value)
      }
      if (event.key === 'Escape') setCommandOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const currentLabel = adminSections.find((item) => item.href === pathname)?.label ?? 'Operations Dashboard'

  return (
    <div className={`enterprise-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`enterprise-sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Primary navigation">
        <div className="enterprise-brand">
          <span className="enterprise-mark"><Hotel size={17} /></span>
          <span className="brand-copy"><strong>bedbank</strong><small>CONTROL PLANE</small></span>
          <button className="sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={17} /></button>
        </div>
        <div className="context-switcher">
          <button className="context-button" onClick={() => setTenantOpen((value) => !value)} aria-expanded={tenantOpen}>
            <span className="context-avatar">{tenant.name.slice(0, 1)}</span>
            <span className="context-copy"><small>ACTIVE CONTEXT</small><strong>{tenant.name}</strong></span><ChevronDown size={14} />
          </button>
          {tenantOpen && <div className="context-menu">{demoTenants.map((item) => <button key={item.id} onClick={() => { setTenant(item); setTenantOpen(false) }}><span>{item.name}</span><small>{item.code}</small></button>)}</div>}
        </div>
        <div className="shell-caption">ADMIN / EXTRANET</div>
        <nav className="enterprise-nav">
          {adminSections.map((item) => <Link key={item.href} href={item.href} title={collapsed ? item.label : undefined} onClick={() => setMobileOpen(false)} className={pathname === item.href ? 'active' : ''}><span className="nav-glyph">{icons[item.icon] ?? '•'}</span><span className="nav-label">{item.label}</span>{item.href === '/admin' && <i />}</Link>)}
        </nav>
        <div className="sidebar-footer">
          <div className="security-note"><ShieldCheck size={15} /><span><strong>Tenant isolation</strong><small>Policy engine active</small></span></div>
          <div className="session-user"><span className="user-initials">JD</span><span className="session-copy"><strong>{demoSession.user.name}</strong><small>Platform Admin</small></span><button aria-label="User menu"><UserCircle size={16} /></button></div>
        </div>
      </aside>
      <main className="enterprise-main">
        <header className="enterprise-topbar">
          <button className="mobile-nav-trigger" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={18} /></button>
          <div className="shell-breadcrumb"><span>Platform</span><b>/</b><strong>{currentLabel}</strong></div>
          <button className="command-trigger" onClick={() => setCommandOpen(true)}><Search size={14} /><span>Search hotels, bookings, suppliers...</span><kbd><Command size={11} /> K</kbd></button>
          <div className="shell-actions"><span className="production-status"><i /> PRODUCTION</span><button className="top-icon" aria-label="Notifications"><Bell size={16} /><i /></button><button className="top-icon" aria-label="User profile"><UserCircle size={18} /></button><button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>◀</button></div>
        </header>
        {children}
      </main>
      {mobileOpen && <button className="shell-overlay" onClick={() => setMobileOpen(false)} aria-label="Close navigation overlay" />}
      {commandOpen && <div className="command-backdrop" onClick={() => setCommandOpen(false)}><div className="command-dialog" role="dialog" aria-modal="true" aria-label="Command center" onClick={(event) => event.stopPropagation()}><div className="command-input"><Search size={16} /><input autoFocus placeholder="Search the control plane" /><kbd>ESC</kbd></div><div className="command-section"><small>QUICK ACCESS</small>{['Operations Dashboard', 'Tenant directory', 'Hotel master', 'Audit activity'].map((label) => <button key={label}><span className="command-dot" />{label}<span>↵</span></button>)}</div><div className="command-foot"><span>Navigate with ↑ ↓</span><span>Open with Enter</span></div></div></div>}
    </div>
  )
}
