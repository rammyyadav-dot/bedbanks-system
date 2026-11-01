import Link from 'next/link'
import { ArrowUpRight, Check, ChevronRight } from 'lucide-react'
import { SiteShell } from '../components/layout/SiteShell'
import { NetworkVisual } from '../components/sections/NetworkVisual'
import { SectionHeading } from '../components/ui/SectionHeading'
import { marketplaceSides, messaging, operatingPrinciples, partnerRoutes, solutionCards, whyFabbeds } from '../lib/content'

export default function HomePage() {
  return <SiteShell>
    <section className="home-hero grid-lines"><div className="container-wide home-hero-grid"><div className="hero-content">
      <p className="status-pill"><span /> {messaging.positioning}</p>
      <h1>{messaging.tagline}</h1>
      <p className="hero-copy">Connecting global hotel supply with travel businesses ready to go further. fabbeds is building a connected B2B hotel distribution marketplace for hotels, accommodation suppliers, DMCs, bedbanks, travel agencies, tour operators, and distribution partners.</p>
      <div className="hero-actions"><Link href="/request-demo" className="button button-primary">Join as a Travel Buyer <ArrowUpRight size={17} aria-hidden="true" /></Link><Link href="/request-demo" className="button button-secondary">Partner with fabbeds</Link></div>
      <ul className="hero-checks" aria-label="Brand promise"><li><Check aria-hidden="true" /> More connections</li><li><Check aria-hidden="true" /> Smarter distribution</li><li><Check aria-hidden="true" /> Greater opportunity</li></ul>
    </div><div className="hero-visual-wrap"><NetworkVisual /><div className="hero-caption"><span className="hero-caption-dot" /> One connected view of supply, rules and demand.</div></div></div></section>

    <section id="marketplace" className="container-wide section-space"><SectionHeading eyebrow="The marketplace" title="One marketplace. Two sides of the travel industry." text="Travel distribution works best when hotel supply and buyer demand connect efficiently. fabbeds is being developed to bring these sides closer together through a structured B2B marketplace built for the way travel businesses operate." /><div className="three-column">{marketplaceSides.map(({ icon: Icon, title, text }) => <article className="icon-card" key={title}><Icon aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div></section>

    <section className="panel-section"><div className="container-wide"><SectionHeading eyebrow="Our solutions" title="Start from the side of the market you work on." text="Two primary journeys, one connected ecosystem." /><div className="three-column">{solutionCards.map(({ icon: Icon, title, tagline, text, audience, href, cta }) => <Link href={href} className="audience-card" key={href}><Icon aria-hidden="true" /><h3>{title}</h3><p><strong>{tagline}</strong></p><p>{text}</p><p>{audience}</p><span>{cta} <ChevronRight aria-hidden="true" /></span></Link>)}</div></div></section>

    <section className="container-wide section-space"><SectionHeading eyebrow="Why fabbeds?" title="A smarter way to connect travel supply and demand." text="Fragmented supplier relationships, inconsistent rate information, disconnected workflows, and changing customer requirements can make sourcing accommodation unnecessarily difficult. fabbeds aims to simplify the process through a structured marketplace that brings supply, commercial rules, search, and buyer access together." /><div className="three-column">{whyFabbeds.map(({ icon: Icon, title, text }) => <article className="icon-card" key={title}><Icon aria-hidden="true" /><h3>{title}</h3><p>{text}</p></article>)}</div></section>

    <section className="dark-section"><div className="container-wide two-column"><div><p className="eyebrow">How it works</p><h2>One connected distribution model.</h2><p>fabbeds is designed around the relationship between hotel inventory, supplier agreements, distribution rules, and travel buyer demand.</p><Link href="/how-it-works" className="text-link-light">See how it works <ArrowUpRight aria-hidden="true" /></Link></div><div className="control-list"><div><strong>01</strong><span><b>Hotels &amp; accommodation suppliers</b>Property content, room types, contracted rates, availability.</span></div><div><strong>02</strong><span><b>The fabbeds distribution platform</b>Hotel master, contract management, rate rules, search, buyer access.</span></div><div><strong>03</strong><span><b>Travel buyers &amp; distribution partners</b>Agencies, tour operators, DMCs, wholesalers, travel platforms.</span></div></div></div></section>

    <section className="container-wide section-space"><SectionHeading eyebrow="Trust and operating principles" title="Better information. Clearer decisions." text="In B2B hotel distribution, the quality of the transaction depends on the quality of the underlying information." /><div className="three-column">{operatingPrinciples.map(({ title, text }) => <article className="content-card" key={title}><h3>{title}</h3><p>{text}</p></article>)}</div><p className="page-note" role="note">Live availability, connectivity and booking services are offered only where they have been implemented, tested and enabled. We publish scale, coverage and partner claims only once they are verified.</p></section>

    <section className="panel-section"><div className="container-wide"><SectionHeading eyebrow="Partner with us" title="Let’s Build Better Connections in Travel." text="Join the fabbeds partner ecosystem and explore how a connected B2B marketplace can support the next stage of your business." /><div className="partner-grid">{partnerRoutes.map((route) => <article key={route.title}><h3>{route.title}</h3><p>{route.text}</p><Link href="/request-demo" className="button button-primary">{route.cta} <ArrowUpRight size={16} aria-hidden="true" /></Link></article>)}</div></div></section>
  </SiteShell>
}
