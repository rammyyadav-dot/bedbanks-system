'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ShieldCheck, X } from 'lucide-react'
import { formatSupplierType } from '../../lib/format'
import { logoutAction, selectOrganizationAction } from '../../lib/actions'
import { navSections } from './nav-config'
import { OrganizationChooser, type ShellOrganization } from './OrganizationChooser'

export type { ShellOrganization }

export function Sidebar({
  mobileOpen,
  onClose,
  userLabel,
  userDetail,
  organizations,
  active,
}: {
  mobileOpen: boolean
  onClose: () => void
  userLabel: string
  userDetail: string
  organizations: ShellOrganization[]
  active: ShellOrganization | null
}) {
  const pathname = usePathname()
  const initials = userLabel.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'S'

  return (
    <aside className={`supplier-sidebar ${mobileOpen ? 'is-open' : ''}`} aria-label="Supplier navigation">
      <div className="supplier-brand">
        <span className="supplier-brand-mark">f</span>
        <span><strong>fBeds</strong><small>SUPPLIER EXTRANET</small></span>
        <button className="sidebar-close" type="button" onClick={onClose} aria-label="Close navigation"><X size={18} /></button>
      </div>

      {organizations.length > 1 ? (
        <OrganizationChooser organizations={organizations} activeSupplierId={active?.supplierId ?? ''} action={selectOrganizationAction} />
      ) : (
        <div className="context-switcher" aria-label="Current supplier organization">
          <span className="context-avatar">{(active?.displayName ?? 'NA').slice(0, 2).toUpperCase()}</span>
          <span>
            <small>{active ? formatSupplierType(active.type) : 'No organization'}</small>
            <strong>{active?.displayName ?? 'Membership required'}</strong>
          </span>
        </div>
      )}

      <nav className="supplier-nav" aria-label="Primary">
        {navSections.map((section, index) => (
          <div className="nav-section" key={section.label ?? index}>
            {section.label && <p>{section.label}</p>}
            {section.items.map((item) => {
              const activeLink = pathname === item.href || pathname.startsWith(`${item.href}/`)
              const Icon = item.icon
              return (
                <Link key={item.href} href={item.href} className={activeLink ? 'active' : ''} onClick={onClose}>
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="demo-notice"><ShieldCheck size={17} /><span><strong>No live supply</strong><small>Publication and booking are unavailable</small></span></div>
        <div className="sidebar-user">
          <span>{initials}</span>
          <div><strong>{userLabel}</strong><small>{userDetail}</small></div>
        </div>
        <form action={logoutAction}>
          <button className="btn" type="submit" style={{ width: '100%', marginTop: 10 }}>Sign out</button>
        </form>
      </div>
    </aside>
  )
}
