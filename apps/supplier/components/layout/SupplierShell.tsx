'use client'

import { useState, type ReactNode } from 'react'
import { Sidebar, type ShellOrganization } from './Sidebar'
import { Topbar } from './Topbar'

export function SupplierShell({
  children,
  userLabel,
  userDetail,
  organizations,
  active,
}: {
  children: ReactNode
  userLabel: string
  userDetail: string
  organizations: ShellOrganization[]
  active: ShellOrganization | null
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const initials = userLabel.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'S'

  return (
    <div className="supplier-shell">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} userLabel={userLabel} userDetail={userDetail} organizations={organizations} active={active} />
      {mobileOpen && <button className="supplier-overlay" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <div className="supplier-main">
        <Topbar onMenuClick={() => setMobileOpen(true)} initials={initials} />
        <main>{children}</main>
      </div>
    </div>
  )
}
