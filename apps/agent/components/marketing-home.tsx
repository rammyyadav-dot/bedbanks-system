'use client'

import { useState } from 'react'

const navItems = ['Marketplace', 'Suppliers', 'Travel Buyers', 'Technology', 'Company', 'Insights']

export function MarketingHome() {
  const [joinOpen, setJoinOpen] = useState(false)

  return (
    <main className="marketing-site">
      <header className="marketing-header">
        <a className="marketing-logo" href="#top" aria-label="fabBeds home">
          <span className="marketing-logo-mark">f</span>
          <span><strong>fabBeds</strong><small>THE WORLD'S WHOLESALE MARKETPLACE</small></span>
        </a>
        <nav className="marketing-nav" aria-label="Main navigation">
          {navItems.map((item) => <a key={item} href={`#${item.toLowerCase().replace(' ', '-')}`}>{item}</a>)}
        </nav>
        <div className="marketing-actions">
          <a className="marketing-signin" href="/login">Sign In</a>
          <button className="marketing-button marketing-button-small" onClick={() => setJoinOpen(true)}>Join fabBeds</button>
        </div>
      </header>

      <section className="marketing-hero" id="top">
        <img src="/fabBeds-hero.png" alt="Modern resort beside a blue Mediterranean coastline" />
        <div className="marketing-hero-overlay" />
        <div className="marketing-hero-content">
          <p className="marketing-eyebrow">THE WORLD'S WHOLESALE MARKETPLACE</p>
          <h1>Where the world<br /><em>moves travel.</em></h1>
          <p className="marketing-hero-copy">Connecting global hotel supply with the businesses that move travel.</p>
          <div className="marketing-hero-actions">
            <button className="marketing-button" onClick={() => setJoinOpen(true)}>Join the marketplace <span>→</span></button>
            <a className="marketing-text-link" href="#marketplace">Explore how it works <span>↓</span></a>
          </div>
        </div>
        <div className="marketing-hero-note">A smarter way to source, distribute<br />and grow hotel business.</div>
      </section>

      <section className="marketing-intro" id="marketplace">
        <div><p className="marketing-eyebrow marketing-eyebrow-dark">ONE MARKETPLACE. TWO SIDES OF TRAVEL.</p><h2>Built for the<br /><em>business of travel.</em></h2></div>
        <div className="marketing-intro-copy"><p>fabBeds brings accommodation supply and professional travel buyers together in one focused wholesale marketplace.</p><p>Less friction. More choice. Better connections that help every side of the industry move further.</p><a href="#how-it-works" className="marketing-arrow-link">Discover fabBeds <span>↗</span></a></div>
      </section>

      <section className="marketing-audiences" id="suppliers">
        <article className="marketing-audience-card marketing-audience-dark"><p className="marketing-eyebrow">FOR SUPPLIERS</p><h3>Put your hotel supply in front of a world of travel businesses.</h3><p>Reach the buyers that matter, with the commercial control and connectivity to grow on your terms.</p><a href="#contact">Become a supply partner <span>↗</span></a></article>
        <article className="marketing-audience-card marketing-audience-red" id="travel-buyers"><p className="marketing-eyebrow">FOR TRAVEL BUYERS</p><h3>More hotel supply.<br />One smarter marketplace.</h3><p>Source, compare and validate hotel stays with a marketplace designed around the way you work.</p><a href="#contact">Join as a travel buyer <span>↗</span></a></article>
      </section>

      <section className="marketing-process" id="how-it-works">
        <div><p className="marketing-eyebrow marketing-eyebrow-dark">THE FAB BEDS DIFFERENCE</p><h2>Move with<br /><em>confidence.</em></h2></div>
        <div className="marketing-process-list">{[['01','Search','Find the right supply for every journey.'],['02','Compare','See the detail that makes the difference.'],['03','Select','Choose with clarity and commercial confidence.'],['04','Validate','Know it is right before you move forward.']].map(([number,title,copy]) => <div className="marketing-process-row" key={number}><span>{number}</span><strong>{title}</strong><p>{copy}</p><b>↗</b></div>)}</div>
      </section>

      <section className="marketing-cta" id="contact"><p className="marketing-eyebrow">READY TO MOVE TRAVEL FORWARD?</p><h2>Let's make<br /><em>the connection.</em></h2><button className="marketing-button" onClick={() => setJoinOpen(true)}>Join fabBeds <span>→</span></button></section>

      <footer className="marketing-footer" id="company">
        <div className="marketing-footer-brand"><a className="marketing-logo" href="#top"><span className="marketing-logo-mark">f</span><span><strong>fabBeds</strong><small>THE WORLD'S WHOLESALE MARKETPLACE</small></span></a><p>Connecting global hotel supply with the businesses that move travel.</p></div>
        <div className="marketing-footer-columns"><div><strong>Marketplace</strong><a href="#marketplace">Hotels & Resorts</a><a href="#marketplace">Destinations</a></div><div><strong>Suppliers</strong><a href="#suppliers">Supplier Solutions</a><a href="#contact">Become a Partner</a></div><div><strong>Travel Buyers</strong><a href="#travel-buyers">Buyer Solutions</a><a href="#contact">Join the Marketplace</a></div><div><strong>Company</strong><a href="#company">About fabBeds</a><a href="#contact">Contact</a></div></div>
        <div className="marketing-footer-bottom"><span>© 2026 fabBeds. All rights reserved.</span><span>Privacy · Terms · Cookies</span></div>
      </footer>

      {joinOpen && <div className="marketing-modal-backdrop" role="presentation" onClick={() => setJoinOpen(false)}><div className="marketing-modal" role="dialog" aria-modal="true" aria-labelledby="join-title" onClick={(event) => event.stopPropagation()}><button className="marketing-modal-close" aria-label="Close" onClick={() => setJoinOpen(false)}>×</button><p className="marketing-eyebrow marketing-eyebrow-dark">JOIN FAB BEDS</p><h2 id="join-title">How would you like<br /><em>to work with us?</em></h2><a href="#contact" onClick={() => setJoinOpen(false)}>I'm a Hotel / Supplier <span>→</span></a><a href="#contact" onClick={() => setJoinOpen(false)}>I'm a Travel Buyer <span>→</span></a></div></div>}
    </main>
  )
}
