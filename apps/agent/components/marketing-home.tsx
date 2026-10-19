import Link from 'next/link'
import { ArrowRight, Calculator, GitCompareArrows, MapPin, RefreshCcw, ShieldCheck, WalletCards } from 'lucide-react'
import { BrandLogo } from '@/components/brand-logo'
import { TradeFooter } from '@/components/entrance/trade-frame'
import { heroCopy, homeCopy } from '@/lib/marketplace-content'

const navItems = [['About', '/about'], ['Support', '/support'], ['News', '/news'], ['Contact', '/contact']] as const

const stepIcons = [MapPin, GitCompareArrows, RefreshCcw, ShieldCheck] as const
const techIcons = [RefreshCcw, Calculator, WalletCards, ShieldCheck] as const

/** Public entrance. Everything here describes what the workspace does; no inventory, volume or price claims. */
export function MarketingHome() {
  return (
    <div className="site">
      <header className="site-header">
        <Link href="/" className="site-logo" aria-label="fabBeds home"><BrandLogo /></Link>
        <nav className="site-nav" aria-label="Main navigation">
          {navItems.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
        </nav>
        <div className="site-actions">
          <Link className="site-link" href="/access">Request access</Link>
          <Link className="site-btn" href="/login">Agent sign in</Link>
        </div>
      </header>

      <main>
        <section className="site-hero" aria-labelledby="site-title">
          <div className="site-hero-copy">
            <p className="site-eyebrow">{heroCopy.eyebrow}</p>
            <h1 id="site-title">{heroCopy.headline}</h1>
            <p className="site-lead">{heroCopy.supporting}</p>
            <div className="site-cta">
              <Link className="site-btn site-btn-lg" href="/login">{heroCopy.primaryCta} <ArrowRight size={18} aria-hidden="true" /></Link>
              <Link className="site-btn site-btn-lg site-btn-ghost" href="/access">{heroCopy.secondaryCta}</Link>
            </div>
            <p className="site-note">{heroCopy.partnerInvitation}</p>
          </div>
          <figure className="site-hero-media">
            <img src="/dubai-marina-entrance.jpg" alt="Dubai marina waterfront in late afternoon light, with towers reflected in calm water." width={1280} height={720} />
          </figure>
        </section>

        <section className="site-section" aria-labelledby="site-steps">
          <p className="site-eyebrow">How it works</p>
          <h2 id="site-steps">{homeCopy.stepsTitle}</h2>
          <ol className="site-steps">
            {homeCopy.steps.map(({ title, text }, index) => {
              const Icon = stepIcons[index]
              return (
                <li key={title}>
                  <span className="site-step-icon" aria-hidden="true"><Icon size={20} /></span>
                  <span className="site-step-num">Step {index + 1}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              )
            })}
          </ol>
          <p className="site-fineprint">{homeCopy.stepsNote}</p>
        </section>

        <section className="site-section site-section-tint" aria-labelledby="site-strengths">
          <p className="site-eyebrow">Built for trade</p>
          <h2 id="site-strengths">{homeCopy.techTitle}</h2>
          <ul className="site-cards">
            {homeCopy.tech.map(({ title, text }, index) => {
              const Icon = techIcons[index]
              return <li key={title}><span className="site-step-icon" aria-hidden="true"><Icon size={20} /></span><h3>{title}</h3><p>{text}</p></li>
            })}
          </ul>
        </section>

        <section className="site-band" aria-labelledby="site-join">
          <div>
            <h2 id="site-join">{homeCopy.bandTitle}</h2>
            <p>{homeCopy.bandText}</p>
          </div>
          <div className="site-cta">
            <Link className="site-btn site-btn-lg site-btn-light" href="/access">{heroCopy.secondaryCta}</Link>
            <Link className="site-btn site-btn-lg site-btn-outline" href="/login">{heroCopy.primaryCta}</Link>
          </div>
        </section>
      </main>

      <div className="site-footer"><TradeFooter /></div>
    </div>
  )
}
