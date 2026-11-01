'use client'

import { Menu } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { flatNav } from './nav-config'

export function Topbar({ onMenuClick, initials, userLabel, organizationName }: { onMenuClick: () => void; initials: string; userLabel: string; organizationName: string | null }) {
  const pathname = usePathname()
  const item = flatNav.find((navItem) => pathname === navItem.href || pathname.startsWith(`${navItem.href}/`))

  return (
    <header className="supplier-topbar">
      <div className="topbar-context">
        <button type="button" className="mobile-menu" onClick={onMenuClick} aria-label="Open navigation"><Menu size={20} /></button>
        <div className="breadcrumbs"><span>Supplier Extranet</span><b>/</b><strong>{item?.label ?? 'Workspace'}</strong></div>
      </div>
      <div className="topbar-spacer" aria-hidden="true" />
      <div className="topbar-actions">
        <span className="environment-pill is-offline"><i />NO LIVE SUPPLY</span>
        <div className="topbar-person">
          <div><strong>{userLabel}</strong><small>{organizationName ?? 'No organization selected'}</small></div>
          <span className="topbar-user" aria-hidden="true">{initials}</span>
        </div>
      </div>
    </header>
  )
}
