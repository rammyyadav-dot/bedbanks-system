import Link from 'next/link'
import { ArrowUpRight, Check, ChevronRight } from 'lucide-react'
import { SiteShell } from '../components/layout/SiteShell'
import { CTA } from '../components/sections/CTA'
import { NetworkVisual } from '../components/sections/NetworkVisual'
import { SectionHeading } from '../components/ui/SectionHeading'
import { audiences, capabilities, operationalPrinciples, workflow } from '../lib/content'

export default function HomePage() {
  return <SiteShell>
    <section className="home-hero grid-lines"><div className="container-wide home-hero-grid"><div>
      <p className="status-pill"><span /> Hotel distribution, made operational</p>
      <h1>Connect hotel supply with B2B demand.</h1>
      <p className="hero-copy">fBeds is a hotel-distribution platform for teams that source, structure, sell and operate accommodation inventory.</p>
      <div className="hero-actions"><Link href="/request-demo" className="button button-primary">Request a demo <ArrowUpRight size={17} aria-hidden="true" /></Link><Link href="/platform" className="button button-secondary">Explore the platform</Link></div>
      <ul className="hero-checks" aria-label="Platform principles"><li><Check aria-hidden="true" /> B2B-first workflows</li><li><Check aria-hidden="true" /> Explicit operational controls</li><li><Check aria-hidden="true" /> Integration-ready boundaries</li></ul>
    </div><NetworkVisual /></div></section>

    <section className="ecosystem-strip" aria-label="Who fBeds is designed for"><div className="container-wide">Hotels <span /> DMCs <span /> Travel agencies <span /> Tour operators <span /> Travel technology</div></section>
    <section className="container-wide section-space"><SectionHeading eyebrow="Platform capabilities" title="One operating model across the distribution lifecycle." text="Structure the handoffs between supply, commercial rules, buyer access and booking operations." /><div className="four-column card-grid">{capabilities.map(({ icon: Icon, title, text }) => <article className="icon-card" key={title}><Icon aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div></section>
    <section className="panel-section"><div className="container-wide"><SectionHeading eyebrow="Distribution workflow" title="Move from raw supply to controlled distribution." text="A clear sequence makes gaps visible before they reach a buyer or booking." /><div className="workflow-grid">{workflow.map((item) => <article key={item.number}><span>{item.number}</span><h3>{item.title}</h3><p>{item.text}</p></article>)}</div></div></section>
    <section className="container-wide section-space"><SectionHeading eyebrow="Solutions by business type" title="Start from the work your team owns." text="Each organisation enters hotel distribution with different responsibilities, systems and controls." /><div className="audience-grid">{audiences.map(({ icon: Icon, ...item }) => <Link href={item.href} className="audience-card" key={item.href}><Icon aria-hidden="true" /><h3>{item.title}</h3><p>{item.text}</p><span>View solution <ChevronRight aria-hidden="true" /></span></Link>)}</div></section>
    <section className="dark-section"><div className="container-wide two-column"><div><p className="eyebrow">Connectivity approach</p><h2>Keep integrations explicit, observable and separate from core logic.</h2><p>Supplier adapters and buyer APIs should expose clear contracts, actionable errors and controlled failure states.</p><Link href="/connectivity" className="text-link-light">Explore connectivity <ArrowUpRight aria-hidden="true" /></Link></div><div className="control-list"><div><strong>01</strong><span><b>Contract boundaries</b>Typed inputs, outputs and lifecycle states.</span></div><div><strong>02</strong><span><b>Connector isolation</b>Supplier behavior does not leak into pricing decisions.</span></div><div><strong>03</strong><span><b>Operational visibility</b>Failures become actionable states rather than silent substitutions.</span></div></div></div></section>
    <section className="container-wide section-space"><SectionHeading eyebrow="Operational control" title="Design for the teams responsible after launch." text="Distribution software must remain explainable when inventory, pricing or connections need attention." /><div className="three-column">{operationalPrinciples.map(({ icon: Icon, title, text }) => <article className="content-card" key={title}><Icon aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div></section>
    <section className="panel-section"><div className="container-wide trust-grid"><div><p className="eyebrow">Trust and readiness</p><h2>Claims should follow evidence.</h2><p>fBeds presents current platform direction without inventing customer scale, live connections or certifications.</p></div><ul className="readiness-list"><li><Check aria-hidden="true" /> Security boundaries considered from the start</li><li><Check aria-hidden="true" /> Tenant-aware product architecture</li><li><Check aria-hidden="true" /> Controlled rollout and integration readiness</li></ul></div></section>
    <section className="container-wide section-space resource-preview"><div><p className="eyebrow">Resources</p><h2>Practical guidance for hotel-distribution teams.</h2><p>Explore frameworks for content, inventory, integration and operating readiness.</p></div><Link href="/resources" className="button button-secondary">Visit resources <ArrowUpRight aria-hidden="true" /></Link></section>
    <CTA />
  </SiteShell>
}
