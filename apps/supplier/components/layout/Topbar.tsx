'use client'

import { Bell, CircleHelp, Menu, Search } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { flatNav } from './nav-config'

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const pathname = usePathname()
  const item = flatNav.find((navItem) => pathname === navItem.href || pathname.startsWith(`${navItem.href}/`))

  return (
    <header className="supplier-topbar">
      <div className="topbar-context">
        <button type="button" className="mobile-menu" onClick={onMenuClick} aria-label="Open navigation"><Menu size={20} /></button>
        <div className="breadcrumbs"><span>Supplier Extranet</span><b>/</b><strong>{item?.label ?? 'Dashboard'}</strong></div>
      </div>
      <label className="global-search">
        <Search size={15} />
        <span className="sr-only">Search workspace</span>
        <input placeholder="Search property, booking or contract…" />
        <kbd>/</kbd>
      </label>
      <div className="topbar-actions">
        <span className="environment-pill"><i />UI PREVIEW</span>
        <button type="button" aria-label="Help"><CircleHelp size={18} /></button>
        <button type="button" aria-label="Notifications" className="notification-button"><Bell size={18} /><i /></button>
        <span className="topbar-user">AK</span>
      </div>
    </header>
  )
}
