import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

export function CTA() {
  return <section className="container-wide section-space" aria-labelledby="cta-title"><div className="cta-panel"><div><p className="eyebrow eyebrow-light">Build the next connection</p><h2 id="cta-title">Make hotel distribution a measurable growth advantage.</h2><p>Share your operating model and priorities. We will map the right next conversation without inventing a one-size-fits-all solution.</p></div><Link href="/request-demo" className="button button-primary">Talk to fBeds <ArrowUpRight size={16} aria-hidden="true" /></Link></div></section>
}
