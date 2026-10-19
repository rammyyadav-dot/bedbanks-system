import Link from 'next/link'
import { ArrowRight, Calculator, GitCompareArrows, MapPin, RefreshCcw, ShieldCheck, WalletCards } from 'lucide-react'
import { BrandLogo } from '@/components/brand-logo'
import { TradeFooter } from '@/components/entrance/trade-frame'
import { heroCopy } from '@/lib/marketplace-content'

const navItems = [['About', '/about'], ['Support', '/support'], ['News', '/news'], ['Contact', '/contact']] as const

const steps = [
  { icon: MapPin, title: 'Search', text: 'Pick a destination from the catalogue, then set dates, rooms and guests.' },
  { icon: GitCompareArrows, title: 'Compare', text: 'Review room, board and cancellation terms side by side.' },
  { icon: RefreshCcw, title: 'Recheck', text: 'Confirm price and availability against current inventory before you commit.' },
  { icon: ShieldCheck, title: 'Book', text: 'Hold, check out and confirm, with a voucher and invoice on confirmation.' },
] as const

const strengths = [
  { icon: Calculator, title: 'Clear pricing', text: 'Rates in AED with the stay total shown. Charges paid at the hotel are listed separately and never added to the total.' },
  { icon: WalletCards, title: 'Credit and wallet', text: 'See your agency credit limit, balance and payment status in one place, and declare bank-transfer top-ups.' },
  { icon: ShieldCheck, title: 'Controlled access', text: 'Every request is checked against your agency and role. Your own mark-up for clients is for display only.' },
] as const

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
            <p className="site-eyebrow">Trade workspace for travel agents</p>
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
          <h2 id="site-steps">From search to confirmed booking in four steps</h2>
          <ol className="site-steps">
            {steps.map(({ icon: Icon, title, text }, index) => (
              <li key={title}>
                <span className="site-step-icon" aria-hidden="true"><Icon size={20} /></span>
                <span className="site-step-num">Step {index + 1}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
          <p className="site-fineprint">A search price is a quote. It is confirmed only when a recheck succeeds. Booking is available to agencies where it has been enabled.</p>
        </section>

        <section className="site-section site-section-tint" aria-labelledby="site-strengths">
          <p className="site-eyebrow">Built for trade</p>
          <h2 id="site-strengths">Clarity on every rate, control on every booking</h2>
          <ul className="site-cards">
            {strengths.map(({ icon: Icon, title, text }) => (
              <li key={title}><span className="site-step-icon" aria-hidden="true"><Icon size={20} /></span><h3>{title}</h3><p>{text}</p></li>
            ))}
          </ul>
        </section>

        <section className="site-band" aria-labelledby="site-join">
          <div>
            <h2 id="site-join">Ready to work with fabBeds?</h2>
            <p>Travel agencies can request access. The fabBeds team reviews each request.</p>
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
