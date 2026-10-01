'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { SearchCriteriaForm } from '@/components/search/search-criteria-form'
import { contactEmail, dubaiSpotlight, editorialDestinations, howItWorks, marketplaceHome, privacyLink, tradeAnnouncements } from '@/lib/marketplace-content'
import { guestMarketName } from '@/lib/guest-market'
import { formatStay } from '@/lib/format'
import { type DraftChildAge } from '@/lib/occupancy'
import { deleteRecentSearch, readRecentSearches, recentSearchIdentity, type RecentSearch } from '@/lib/recent-searches'
import { activeFilterLabel, stayOccupancyLabel } from '@/lib/search-summary'

export function AgentHome({
  userId,
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges,
  nationality, setNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
  minPriceAed, setMinPriceAed, maxPriceAed, setMaxPriceAed,
  searching, searchFailed, onSearch, onSearchDubai, onChange, onReplay,
}: {
  userId: string
  destination: string
  setDestination: (value: string) => void
  checkIn: string
  setCheckIn: (value: string) => void
  checkOut: string
  setCheckOut: (value: string) => void
  rooms: number
  setRooms: (value: number) => void
  adults: number
  setAdults: (value: number) => void
  children: number
  updateChildren: (value: number) => void
  childAges: DraftChildAge[]
  setChildAges: (value: DraftChildAge[]) => void
  nationality: string
  setNationality: (value: string) => void
  starRatings: number[]
  setStarRatings: (value: number[]) => void
  refundableOnly: boolean
  setRefundableOnly: (value: boolean) => void
  minPriceAed: string
  setMinPriceAed: (value: string) => void
  maxPriceAed: string
  setMaxPriceAed: (value: string) => void
  searching: boolean
  searchFailed: boolean
  onSearch: () => void
  onSearchDubai: () => void
  onChange: (action: () => void) => void
  onReplay: (search: RecentSearch) => void
}) {
  const [recent, setRecent] = useState<RecentSearch[]>([])
  const [showAll, setShowAll] = useState(false)
  useEffect(() => { setRecent(readRecentSearches(window.sessionStorage, userId)) }, [userId, searching])
  const visible = showAll ? recent : recent.slice(0, 4)
  const remove = (item: RecentSearch) => {
    deleteRecentSearch(window.sessionStorage, userId, item)
    setRecent(readRecentSearches(window.sessionStorage, userId))
  }

  return (
    <div className="trade-home market-home">
      <section className="market-hero">
        <h1>{marketplaceHome.title}</h1>
        <p>{marketplaceHome.supporting}</p>
      </section>
      <SearchCriteriaForm
        destination={destination} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut}
        rooms={rooms} setRooms={setRooms} adults={adults} setAdults={setAdults} children={children} updateChildren={updateChildren} childAges={childAges} setChildAges={setChildAges}
        nationality={nationality} setNationality={setNationality} starRatings={starRatings} setStarRatings={setStarRatings} refundableOnly={refundableOnly} setRefundableOnly={setRefundableOnly}
        minPriceAed={minPriceAed} setMinPriceAed={setMinPriceAed} maxPriceAed={maxPriceAed} setMaxPriceAed={setMaxPriceAed}
        searching={searching} searchFailed={searchFailed} onSubmit={onSearch} onChange={onChange}
      />
      <section className="market-recent" aria-label={marketplaceHome.recentTitle}>
        <div className="market-section-head"><h2>{marketplaceHome.recentTitle}</h2>{recent.length > 4 && <button type="button" className="portal-link" onClick={() => setShowAll((value) => !value)}>{showAll ? 'Show less' : 'View all'}</button>}</div>
        {recent.length === 0 ? <p className="trade-muted">{marketplaceHome.recentEmpty}</p> : (
          <ul className="market-recent-grid">
            {visible.map((item) => (
              <li key={recentSearchIdentity(item)}>
                <strong>{item.destination}</strong>
                <span>{formatStay(item.checkIn, item.checkOut)}</span>
                <span>{stayOccupancyLabel(item.rooms, item.adults, item.children, item.childAges)}{item.nationality ? ` · ${guestMarketName(item.nationality)}` : ''}</span>
                {activeFilterLabel(item) ? <span>{activeFilterLabel(item)}</span> : null}
                <div>
                  <button type="button" className="portal-link" onClick={() => onReplay(item)}>Search again →</button>
                  <button type="button" className="portal-link market-delete" onClick={() => remove(item)} aria-label={`Delete ${item.destination} search`}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="market-strip" aria-label="Dubai search">
        <p>{marketplaceHome.offerStrip}</p>
        <button type="button" className="portal-primary" onClick={onSearchDubai} disabled={searching}>{dubaiSpotlight.action}</button>
      </section>
      <section className="trade-home-grid" aria-label="Marketplace highlights">
        <article className="trade-discovery-card is-authoritative">
          <p className="trade-kicker">Searchable destination</p>
          <h2>{dubaiSpotlight.title}</h2>
          <p>{dubaiSpotlight.text}</p>
          <button type="button" className="portal-primary" onClick={onSearchDubai} disabled={searching}>{dubaiSpotlight.action}</button>
        </article>
        <article className="trade-discovery-card">
          <p className="trade-kicker">Editorial</p>
          <h2>Other destinations</h2>
          <ul>
            {editorialDestinations.map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.note}</span></li>)}
          </ul>
        </article>
        <article className="trade-discovery-card">
          <p className="trade-kicker">Quotes</p>
          <h2>Rates come from search</h2>
          <p>This page does not publish a price list. Open a hotel from the search results to see the room, board basis, currency, and total stay price for the dates you entered.</p>
        </article>
      </section>
      <section className="trade-announcements" aria-label="Marketplace notices">
        <h2>Marketplace notices</h2>
        <div className="trade-home-grid">
          {tradeAnnouncements.map((item) => <article key={item.title} className="trade-discovery-card"><p className="trade-kicker">Notice</p><h3>{item.title}</h3><p>{item.text}</p></article>)}
        </div>
      </section>
      <section className="trade-home-split">
        <div>
          <h2>How it works</h2>
          <ol className="trade-steps">
            {howItWorks.map((step, index) => <li key={step.title}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.text}</p></div></li>)}
          </ol>
        </div>
        <div>
          <h2>Support</h2>
          <ul className="trade-link-list">
            <li><Link href="/support">Agent support</Link></li>
            <li><Link href="/contact">Contact the team</Link></li>
            <li><Link href="/news">Trade updates</Link></li>
            <li><a href={`mailto:${contactEmail}`}>Email {contactEmail}</a></li>
          </ul>
        </div>
      </section>
      <footer className="trade-footer is-quiet">
        <nav><a href={privacyLink.href}>{privacyLink.label}</a><a href={`mailto:${contactEmail}`}>{contactEmail}</a></nav>
        <p className="trade-footer-note">{privacyLink.note} Booking, confirmation, and payment stay off until this workspace enables them.</p>
      </footer>
    </div>
  )
}
