import Link from 'next/link'
import { ArrowUpRight, Check } from 'lucide-react'
import type { MarketingPageContent } from '../../lib/content'
import { SiteShell } from '../layout/SiteShell'
import { CTA } from './CTA'

export function MarketingPage({ content }: { content: MarketingPageContent }) {
  return <SiteShell><section className="container-wide page-hero"><div><p className="eyebrow">{content.eyebrow}</p><h1>{content.title}</h1><p>{content.intro}</p><div className="hero-actions"><Link href="/request-demo" className="button button-primary">Start a conversation <ArrowUpRight size={16} aria-hidden="true" /></Link></div></div><aside className="proof-card"><span>Operating focus</span><strong>{content.proof}</strong></aside></section><section className="container-wide section-space"><div className="three-column">{content.sections.map((section, index) => <article className="content-card" key={section.title}><span className="card-number">0{index + 1}</span><h2>{section.title}</h2><p>{section.text}</p><ul>{section.items.map((item) => <li key={item}><Check size={17} aria-hidden="true" />{item}</li>)}</ul></article>)}</div></section><CTA /></SiteShell>
}
