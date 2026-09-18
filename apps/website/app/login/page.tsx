import Link from 'next/link'
import { ArrowUpRight, ArrowLeft, Building2, Hotel, ShieldCheck } from 'lucide-react'
import { SiteShell } from '../../components/layout/SiteShell'
import { portalHref, siteConfig, type PortalKey } from '../../lib/site-config'

export const metadata = { title: 'Sign in to fBeds', description: 'Choose the fBeds workspace that matches your role.' }

const portals: { key: PortalKey; title: string; description: string; icon: typeof Hotel }[] = [
  { key: 'agent', title: 'Travel Buyer / Agent Portal', description: 'Search, compare and book hotel inventory for your travellers.', icon: Hotel },
  { key: 'supplier', title: 'Hotel, DMC & Supplier Portal', description: 'Manage supply, content and distribution relationships.', icon: Building2 },
  { key: 'admin', title: 'Platform Administration', description: 'Manage operational controls and platform access.', icon: ShieldCheck },
]

export default function LoginPage() {
  return <SiteShell><section className="portal-routing-page"><div className="container-wide portal-routing-inner"><div className="portal-routing-intro"><p className="eyebrow">Workspace access</p><h1>Sign in to fBeds</h1><p>Choose the workspace that matches your role. Each portal opens in its configured operational environment.</p></div><div className="portal-card-grid">{portals.map(({ key, title, description, icon: Icon }) => <a key={key} href={portalHref(key)} className="portal-card"><span className="portal-card-icon"><Icon aria-hidden="true" /></span><span><strong>{title}</strong><small>{description}</small></span><ArrowUpRight aria-hidden="true" /></a>)}</div><div className="portal-routing-actions"><a href={`mailto:${siteConfig.contactEmail}`} className="button button-primary">Need access? Contact fBeds <ArrowUpRight size={16} aria-hidden="true" /></a><Link href="/" className="button button-secondary"><ArrowLeft size={16} aria-hidden="true" /> Return to home</Link></div><p className="portal-routing-note">Portal destinations are configured per deployment. If your workspace is not available, contact your fBeds administrator.</p></div></section></SiteShell>
}
