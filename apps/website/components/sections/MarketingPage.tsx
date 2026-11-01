import Link from 'next/link'
import { ArrowUpRight, Check } from 'lucide-react'
import type { ContentBlock, MarketingPageContent } from '../../lib/content'
import { SiteShell } from '../layout/SiteShell'
import { CTA } from './CTA'

function Block({ block }: { block: ContentBlock }) {
  const heading = <div className="section-heading"><h2>{block.heading}</h2>{block.text && <p>{block.text}</p>}</div>
  if (block.style === 'steps') return <section className="container-wide section-space">{heading}<ol className="step-list">{block.items.map((item) => <li key={item.title}><div><h3>{item.title}</h3><p>{item.text}</p></div></li>)}</ol></section>
  return <section className="container-wide section-space">{heading}<div className="three-column">{block.items.map((item) => <article className="content-card" key={item.title}><h3>{item.title}</h3><p>{item.text}</p></article>)}</div></section>
}

export function MarketingPage({ content }: { content: MarketingPageContent }) {
  const actions = content.actions ?? [{ label: 'Start a conversation', href: '/request-demo' }]
  return <SiteShell>
    <section className="container-wide page-hero"><div><p className="eyebrow">{content.eyebrow}</p><h1>{content.title}</h1><p>{content.intro}</p><div className="hero-actions">{actions.map((action) => <Link key={action.label} href={action.href} className={`button ${action.secondary ? 'button-secondary' : 'button-primary'}`}>{action.label} <ArrowUpRight size={16} aria-hidden="true" /></Link>)}</div></div><aside className="proof-card"><span>At a glance</span><strong>{content.proof}</strong></aside></section>
    <section className="container-wide section-space"><div className="three-column">{content.sections.map((section, index) => <article className="content-card" key={section.title}><span className="card-number">0{index + 1}</span><h2>{section.title}</h2><p>{section.text}</p>{section.items && <ul>{section.items.map((item) => <li key={item}><Check size={17} aria-hidden="true" />{item}</li>)}</ul>}</article>)}</div>{content.note && <p className="page-note" role="note">{content.note}</p>}</section>
    {content.blocks?.map((block) => <Block key={block.heading} block={block} />)}
    {content.faq && <section className="container-wide section-space" aria-labelledby="faq-title"><div className="section-heading"><h2 id="faq-title">Frequently asked questions</h2></div><div className="faq-list">{content.faq.map((item) => <details key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</div></section>}
    <CTA />
  </SiteShell>
}
