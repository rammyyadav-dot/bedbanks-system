import Link from 'next/link'
import { AccessRequestForm } from '@/components/entrance/access-request-form'
import { TradeFooter, TradeMark } from '@/components/entrance/trade-frame'
import { accessCopy, brandTagline } from '@/lib/marketplace-content'
import type { MarketContent } from '@/lib/landing-markets'

/**
 * One programmatic SEO landing page body (ADR 0093). The CTA is the same locally-validated access-request form used
 * on /access — there is no second lead pipeline and nothing here claims a submission reached a server.
 */
export function MarketLandingPage({ market }: { market: MarketContent }) {
  return (
    <div className="trade-public access-page">
      <header className="trade-public-bar">
        <Link href="/" aria-label="fabBeds agent entrance"><TradeMark /></Link>
        <Link className="trade-button" href="/">Agent Sign In</Link>
      </header>
      <main className="access-main">
        <nav className="access-crumbs" aria-label="Breadcrumb"><Link href="/">Home</Link> <span aria-hidden="true">›</span> <span>{market.kicker}</span></nav>

        <section className="access-hero" aria-labelledby="landing-title">
          <div className="access-hero-copy">
            <p className="trade-kicker">{market.kicker}<span aria-hidden="true">.</span></p>
            <h1 id="landing-title">{market.headline}</h1>
            <p className="access-hook">{market.lead} <span>{brandTagline}</span></p>
            <a className="trade-button" href="#request">Request agent access</a>
          </div>
          <figure className="access-hero-media">
            <img src={market.heroImage.src} alt={market.heroImage.alt} width={1376} height={768} fetchPriority="high" />
          </figure>
        </section>

        <ul className="landing-points" aria-label={`What a ${market.region} agency gets`}>
          {market.points.map((point) => (
            <li key={point.title}>
              <h2>{point.title}</h2>
              <p>{point.text}</p>
            </li>
          ))}
        </ul>

        <section id="request" className="access-request" aria-label={accessCopy.formTitle}>
          <p className="access-prepare">{accessCopy.prepare}</p>
          <AccessRequestForm />
        </section>
      </main>
      <TradeFooter />
    </div>
  )
}
