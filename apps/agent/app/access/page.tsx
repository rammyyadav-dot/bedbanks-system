import Link from 'next/link'
import { AccessRequestForm } from '@/components/entrance/access-request-form'
import { TradeFooter, TradeMark } from '@/components/entrance/trade-frame'
import { accessCopy, contactEmail, editorialPages } from '@/lib/marketplace-content'

export default function AccessPage() {
  const page = editorialPages.access
  return (
    <div className="trade-public access-page">
      <header className="trade-public-bar">
        <Link href="/" aria-label="fabBeds agent entrance"><TradeMark /></Link>
        <Link className="trade-button" href="/">Agent Sign In</Link>
      </header>
      <main className="access-main">
        <nav className="access-crumbs" aria-label="Breadcrumb"><Link href="/">Home</Link> <span aria-hidden="true">›</span> <span>Request Agent Access</span></nav>

        <section className="access-hero">
          <p className="trade-kicker">{page.kicker}</p>
          <h1>{page.title}</h1>
          <p className="trade-lead">{page.summary}</p>
          <p className="trade-muted">Access is granted only after the fabBeds team reviews the request. Online submission is not configured, so you send the final email yourself to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.</p>
        </section>

        <section aria-labelledby="access-steps-title" className="access-steps-section">
          <h2 id="access-steps-title">How a request works</h2>
          <ol className="access-steps">
            {accessCopy.steps.map((step, index) => (
              <li key={step.title}><span aria-hidden="true">{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></li>
            ))}
          </ol>
        </section>

        <div className="access-layout">
          <AccessRequestForm />
          <aside className="access-aside" aria-label="Before you apply">
            <section>
              <h2>{accessCopy.prepareTitle}</h2>
              <ul>{accessCopy.prepare.map((item) => <li key={item}>{item}</li>)}</ul>
            </section>
            <section>
              <h2>{accessCopy.reviewTitle}</h2>
              {accessCopy.review.map((item) => <p key={item.title}><strong>{item.title}.</strong> {item.text}</p>)}
            </section>
          </aside>
        </div>

        <section className="access-supplier" aria-labelledby="access-supplier-title">
          <h2 id="access-supplier-title">{accessCopy.supplierTitle}</h2>
          <p>{accessCopy.supplierText}</p>
        </section>
        <p><Link href="/">Return to the agent workspace</Link></p>
      </main>
      <TradeFooter />
    </div>
  )
}
