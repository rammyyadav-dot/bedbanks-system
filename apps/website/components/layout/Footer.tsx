import Link from 'next/link'
import { footerNavigation, portalLabels } from '../../lib/navigation'
import { portalHref, siteConfig, type PortalKey } from '../../lib/site-config'
import { Logo } from '../ui/Logo'

export function Footer() {
  return <footer className="site-footer">
    <div className="container-wide footer-grid">
      <div><Logo inverse /><p>The connected operating layer for modern B2B hotel distribution.</p><a href={`mailto:${siteConfig.contactEmail}`}>{siteConfig.contactEmail}</a></div>
      <FooterColumn title="Explore" items={footerNavigation.explore} />
      <FooterColumn title="Company" items={footerNavigation.company} />
      <div><p className="footer-label">Portals</p><div className="footer-links">{(Object.keys(portalLabels) as PortalKey[]).map((key) => <a key={key} href={portalHref(key)}>{portalLabels[key]}</a>)}</div></div>
    </div>
    <div className="container-wide footer-base"><span>© 2026 fBeds. Built for better distribution.</span><span>Public website · {new URL(siteConfig.siteUrl).hostname}</span></div>
  </footer>
}

function FooterColumn({ title, items }: { title: string; items: { label: string; href: string }[] }) {
  return <div><p className="footer-label">{title}</p><div className="footer-links">{items.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}</div></div>
}
