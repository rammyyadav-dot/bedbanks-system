'use client'

import { useState, type ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

export function SupplierShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="supplier-shell">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      {mobileOpen && <button className="supplier-overlay" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <div className="supplier-main">
        <Topbar onMenuClick={() => setMobileOpen(true)} />
        <main>{children}</main>
      </div>
    </div>
  )
}
