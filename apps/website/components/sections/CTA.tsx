import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

export function CTA() {
  return <section className="container-wide section-space" aria-labelledby="cta-title"><div className="cta-panel"><div><p className="eyebrow eyebrow-light">Built for Travel Businesses. Driven by Partnerships.</p><h2 id="cta-title">Let’s Build Better Connections in Travel.</h2><p>Whether you supply accommodation or source hotels for your customers, the right distribution relationships can open new commercial opportunities.</p></div><Link href="/request-demo" className="button button-primary">Discuss a Partnership <ArrowUpRight size={16} aria-hidden="true" /></Link></div></section>
}
