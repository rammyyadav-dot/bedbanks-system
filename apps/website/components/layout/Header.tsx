'use client'

import Link from 'next/link'
import { Menu, X, ArrowUpRight } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { primaryNavigation } from '../../lib/navigation'
import { trackWebsiteEvent } from '../../lib/analytics'
import { Logo } from '../ui/Logo'

export function Header() {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => { setOpen(false) }, [pathname])
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    window.addEventListener('keydown', close)
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close) }
  }, [open])

  const navLink = (item: { label: string; href: string }) => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>{item.label}</Link>

  return <header className="site-header">
    <div className="container-wide header-inner">
      <Logo />
      <nav className="desktop-nav" aria-label="Primary navigation">{primaryNavigation.map(navLink)}</nav>
      <div className="header-actions">
        <Link href="/login" className="signin-link" onClick={() => trackWebsiteEvent('portal_link_selected', { portal: 'agent' })}>Portal sign in</Link>
        <Link href="/request-demo" className="button button-primary" onClick={() => trackWebsiteEvent('primary_cta_selected', { placement: 'header' })}>Request a demo <ArrowUpRight size={15} aria-hidden="true" /></Link>
        <button ref={trigger} className="menu-trigger" type="button" aria-expanded={open} aria-controls="mobile-navigation" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu aria-hidden="true" /></button>
      </div>
    </div>
    {open && <div className="mobile-nav-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <div id="mobile-navigation" className="mobile-nav" role="dialog" aria-modal="true" aria-label="Mobile navigation">
        <div className="mobile-nav-head"><Logo /><button ref={closeButton} type="button" aria-label="Close navigation" onClick={() => { setOpen(false); trigger.current?.focus() }}><X aria-hidden="true" /></button></div>
        <nav aria-label="Mobile navigation">{primaryNavigation.map(navLink)}</nav>
        <div className="mobile-nav-actions"><Link href="/login" className="button button-secondary" onClick={() => trackWebsiteEvent('portal_link_selected', { portal: 'agent' })}>Portal sign in</Link><Link href="/request-demo" className="button button-primary" onClick={() => trackWebsiteEvent('primary_cta_selected', { placement: 'mobile_navigation' })}>Request a demo</Link></div>
      </div>
    </div>}
  </header>
}
