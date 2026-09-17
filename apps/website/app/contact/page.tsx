import Link from 'next/link'
import { Mail } from 'lucide-react'
import { MarketingPage } from '../../components/sections/MarketingPage'
import { marketingPages } from '../../lib/content'
import { siteConfig } from '../../lib/site-config'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Contact fBeds', description: 'Contact fBeds about hotel supply, B2B distribution or travel-technology integration.', path: '/contact' })
export default function ContactPage() { return <><MarketingPage content={marketingPages.contact} /><aside className="contact-float"><Mail aria-hidden="true" /><span>Prefer email?</span><Link href={`mailto:${siteConfig.contactEmail}`}>{siteConfig.contactEmail}</Link></aside></> }
