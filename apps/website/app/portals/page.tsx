import Link from 'next/link'
import { ArrowLeft, CircleAlert, Mail } from 'lucide-react'
import { Logo } from '../../components/ui/Logo'
import { portalLabels } from '../../lib/navigation'
import { siteConfig, type PortalKey } from '../../lib/site-config'

export const metadata = { title: 'Portal configuration required', robots: { index: false, follow: false } }

export default async function PortalsPage({ searchParams }: { searchParams: Promise<{ target?: string }> }) {
  const { target } = await searchParams
  const key = target && target in portalLabels ? target as PortalKey : undefined
  return <main className="portal-notice"><div className="portal-notice-card"><Logo /><CircleAlert aria-hidden="true" /><p className="eyebrow">Portal routing</p><h1>{key ? `${portalLabels[key]} is not configured` : 'Choose an operational portal from the configured website.'}</h1><p>The marketing site cannot safely route this request until its deployment URL is provided. No localhost or placeholder portal is used in production.</p><div className="hero-actions"><Link href="/" className="button button-secondary"><ArrowLeft aria-hidden="true" /> Return to website</Link><a href={`mailto:${siteConfig.contactEmail}`} className="button button-primary"><Mail aria-hidden="true" /> Contact fBeds</a></div></div></main>
}
