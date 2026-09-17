import { CheckCircle2 } from 'lucide-react'
import { DemoRequestForm } from '../../components/forms/DemoRequestForm'
import { SiteShell } from '../../components/layout/SiteShell'
import { siteConfig } from '../../lib/site-config'
import { pageMetadata } from '../../lib/seo'
export const metadata = pageMetadata({ title: 'Request an fBeds demo', description: 'Tell fBeds about your hotel-distribution model, markets and integration priorities.', path: '/request-demo' })
export default function RequestDemoPage() { return <SiteShell><section className="container-wide demo-layout"><div><p className="eyebrow">Request a demo</p><h1>Plan a useful hotel-distribution conversation.</h1><p className="hero-copy">Tell us whether you source hotels, sell travel or build travel technology. We use this context to prepare a relevant discussion.</p><ul className="demo-benefits"><li><CheckCircle2 aria-hidden="true" /> A focused platform walkthrough</li><li><CheckCircle2 aria-hidden="true" /> Architecture and integration review</li><li><CheckCircle2 aria-hidden="true" /> Commercial and onboarding discussion</li></ul><p className="privacy-note">Your details are used only to respond to this enquiry. No form contents are sent to website analytics.</p></div><DemoRequestForm contactEmail={siteConfig.contactEmail} /></section></SiteShell> }
