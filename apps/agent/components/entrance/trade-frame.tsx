import type { ReactNode } from 'react'
import Link from 'next/link'
import { contactEmail, entranceCards, privacyLink } from '@/lib/marketplace-content'

export function TradeMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`trade-mark ${compact ? 'is-compact' : ''}`}>
      <span className="trade-mark-badge" aria-hidden="true">f</span>
      <span>
        <strong>fBeds</strong>
        {compact ? null : <small>Agent workspace</small>}
      </span>
    </span>
  )
}

export function TradeFooter() {
  return (
    <footer className="trade-footer">
      <div>
        <TradeMark compact />
        <p>Trade contact: <a href={`mailto:${contactEmail}`}>{contactEmail}</a></p>
      </div>
      <nav aria-label="Company">
        {entranceCards.map((card) => <Link key={card.href} href={card.href}>{card.title}</Link>)}
        <a href={privacyLink.href}>{privacyLink.label}</a>
      </nav>
      <p className="trade-footer-note">{privacyLink.note}</p>
    </footer>
  )
}

export function PublicPage({ kicker, title, summary, sections, children }: {
  kicker: string
  title: string
  summary: string
  sections: ReadonlyArray<{ title: string; paragraphs: readonly string[] }>
  children?: ReactNode
}) {
  return (
    <div className="trade-public">
      <header className="trade-public-bar">
        <Link href="/" aria-label="fBeds agent entrance"><TradeMark /></Link>
        <Link className="trade-button" href="/">Agent Sign In</Link>
      </header>
      <main className="trade-public-main">
        <p className="trade-kicker">{kicker}</p>
        <h1>{title}</h1>
        <p className="trade-lead">{summary}</p>
        {sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>
        ))}
        {children}
        <p><Link href="/">Return to the agent workspace</Link></p>
      </main>
      <TradeFooter />
    </div>
  )
}
