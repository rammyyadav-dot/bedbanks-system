import Link from 'next/link'
import { AccessRequestForm } from '@/components/entrance/access-request-form'
import { TradeFooter, TradeMark } from '@/components/entrance/trade-frame'
import { accessCopy, brandTagline, contactEmail, editorialPages } from '@/lib/marketplace-content'

const supplierMail = `mailto:${contactEmail}?subject=${encodeURIComponent(accessCopy.supplier.subject)}`

export default function AccessPage() {
  const page = editorialPages.access
  return (
    <div className="trade-public access-page">
      <header className="trade-public-bar">
        <Link href="/" aria-label="fabBeds agent entrance"><TradeMark /></Link>
        <Link className="trade-button" href="/">Agent Sign In</Link>
      </header>
      <main className="access-main">
        <nav className="access-crumbs" aria-label="Breadcrumb"><Link href="/">Home</Link> <span aria-hidden="true">›</span> <span>{page.kicker}</span></nav>

        <section className="access-hero" aria-labelledby="access-title">
          <div className="access-hero-copy">
            <p className="trade-kicker">{page.kicker}<span aria-hidden="true">.</span></p>
            <h1 id="access-title">{page.title}<span className="access-dot" aria-hidden="true">.</span></h1>
            <p className="access-hook">{accessCopy.hook} <span>{brandTagline}</span></p>
            <p className="trade-muted">{page.summary}</p>
            <ul className="access-perks" aria-label="Why agencies use fabBeds">
              {accessCopy.perks.map((perk) => <li key={perk}>{perk}</li>)}
            </ul>
            <a className="trade-button" href="#request">Request access</a>
          </div>
          <figure className="access-hero-media">
            <img src="/access-resort.jpg" alt="Aerial view of a coastal resort with pool terraces beside the sea at sunset." width={1376} height={768} fetchPriority="high" />
          </figure>
        </section>

        <ol className="access-steps" aria-label="How a request works">
          {accessCopy.steps.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span>{step}</li>)}
        </ol>

        <section id="request" className="access-request" aria-label={accessCopy.formTitle}>
          <p className="access-prepare">{accessCopy.prepare}</p>
          <AccessRequestForm />
        </section>

        <section className="access-supplier" aria-labelledby="access-supplier-title">
          <figure className="access-supplier-media">
            <img src="/dubai-marina-entrance.jpg" alt="Dubai marina waterfront in late afternoon light, with towers reflected in calm water." width={1280} height={720} loading="lazy" />
          </figure>
          <div>
            <h2 id="access-supplier-title">{accessCopy.supplier.title}<span className="access-dot" aria-hidden="true">?</span></h2>
            <p>{accessCopy.supplier.text}</p>
            <a className="access-link" href={supplierMail}>{accessCopy.supplier.cta} <span aria-hidden="true">→</span></a>
          </div>
        </section>
      </main>
      <TradeFooter />
    </div>
  )
}
