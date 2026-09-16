'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronDown, ShieldCheck, X } from 'lucide-react'
import { supplierContexts } from '../../lib/mock-data'
import { formatSupplierType } from '../../lib/format'
import { navSections } from './nav-config'

export function Sidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const pathname = usePathname()
  const activeContext = supplierContexts[0]

  return (
    <aside className={`supplier-sidebar ${mobileOpen ? 'is-open' : ''}`} aria-label="Supplier navigation">
      <div className="supplier-brand">
        <span className="supplier-brand-mark">f</span>
        <span><strong>fBeds</strong><small>SUPPLIER EXTRANET</small></span>
        <button className="sidebar-close" type="button" onClick={onClose} aria-label="Close navigation"><X size={18} /></button>
      </div>

      <button className="context-switcher" type="button" aria-label="Current supplier context">
        <span className="context-avatar">MH</span>
        <span><small>{formatSupplierType(activeContext.type)}</small><strong>{activeContext.name}</strong></span>
        <ChevronDown size={14} />
      </button>

      <nav className="supplier-nav" aria-label="Primary">
        {navSections.map((section, index) => (
          <div className="nav-section" key={section.label ?? index}>
            {section.label && <p>{section.label}</p>}
            {section.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
              const Icon = item.icon
              return (
                <Link key={item.href} href={item.href} className={active ? 'active' : ''} onClick={onClose}>
                  <Icon size={16} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="demo-notice"><ShieldCheck size={17} /><span><strong>UI demonstration</strong><small>Mock data · No live distribution</small></span></div>
        <div className="sidebar-user"><span>AK</span><div><strong>Aisha Khan</strong><small>Supplier Administrator</small></div></div>
      </div>
    </aside>
  )
}
