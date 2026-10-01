'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { SearchCriteriaForm } from '@/components/search/search-criteria-form'
import { contactEmail, dubaiSpotlight, editorialDestinations, howItWorks, tradeAnnouncements } from '@/lib/marketplace-content'
import { readRecentSearches, type RecentSearch } from '@/lib/recent-searches'

function greeting(name: string) {
  const hour = new Date().getHours()
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const first = name.trim().split(/\s+/)[0] || 'there'
  return `${hello}, ${first}`
}

export function AgentHome({
  userId, userName, agency,
  destination, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  rooms, setRooms, adults, setAdults, children, updateChildren, childAges, setChildAges,
  searching, onSearch, onSearchDubai, onChange, onReplay,
}: {
  userId: string
  userName: string
  agency: string
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
  childAges: number[]
  setChildAges: (value: number[]) => void
  searching: boolean
  onSearch: () => void
  onSearchDubai: () => void
  onChange: (action: () => void) => void
  onReplay: (search: RecentSearch) => void
}) {
  const [recent, setRecent] = useState<RecentSearch[]>([])
  useEffect(() => { setRecent(readRecentSearches(window.sessionStorage, userId)) }, [userId, searching])

  return (
    <div className="trade-home">
      <section className="portal-heading-row">
        <div>
          <span className="portal-eyebrow">AGENT WORKSPACE</span>
          <h1>{greeting(userName)}</h1>
          <p>{agency}. Search hotels, compare room and board options, then recheck the offer you want to use.</p>
        </div>
      </section>
      <SearchCriteriaForm
        destination={destination} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut}
        rooms={rooms} setRooms={setRooms} adults={adults} setAdults={setAdults} children={children} updateChildren={updateChildren} childAges={childAges} setChildAges={setChildAges}
        searching={searching} onSubmit={onSearch} onChange={onChange}
      />
      <section className="trade-home-grid" aria-label="Commercial discovery">
        <article className="trade-discovery-card is-authoritative">
          <p className="trade-kicker">Authoritative search</p>
          <h2>{dubaiSpotlight.title}</h2>
          <p>{dubaiSpotlight.text}</p>
          <p className="trade-criteria">{dubaiSpotlight.destination} · {checkIn} to {checkOut} · {rooms} room · {adults} adults{children ? ` · ${children} children` : ''}</p>
          <button type="button" className="portal-primary" onClick={onSearchDubai} disabled={searching}>{dubaiSpotlight.action}</button>
        </article>
        <article className="trade-discovery-card">
          <p className="trade-kicker">Editorial</p>
          <h2>Destination collections</h2>
          <ul>
            {editorialDestinations.map((item) => <li key={item.name}><strong>{item.name}</strong><span>{item.note}</span></li>)}
          </ul>
        </article>
        <article className="trade-discovery-card">
          <p className="trade-kicker">Featured properties</p>
          <h2>Rates come from search</h2>
          <p>This page does not publish a price list. Open a hotel from the search results to see the room, board basis, currency, and total stay price for the dates you entered.</p>
        </article>
      </section>
      <section className="trade-home-split">
        <div>
          <h2>Recent searches</h2>
          {recent.length === 0 ? <p className="trade-muted">Searches you complete in this browser stay on this device for this account until you sign out.</p> : (
            <ul className="trade-recent-list">
              {recent.map((item) => (
                <li key={`${item.destination}-${item.checkIn}-${item.checkOut}-${item.rooms}-${item.adults}-${item.children}`}>
                  <span><strong>{item.destination}</strong><small>{item.checkIn} to {item.checkOut} · {item.rooms} room · {item.adults} adults · {item.children} children</small></span>
                  <button type="button" className="portal-secondary" onClick={() => onReplay(item)}>Search Again</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2>Support and account</h2>
          <ul className="trade-link-list">
            <li><Link href="/support">Agent support</Link></li>
            <li><Link href="/contact">Contact the team</Link></li>
            <li><Link href="/news">Trade updates</Link></li>
            <li><a href={`mailto:${contactEmail}`}>Email {contactEmail}</a></li>
          </ul>
        </div>
      </section>
      <section>
        <h2>How it works</h2>
        <ol className="trade-steps">
          {howItWorks.map((step, index) => <li key={step.title}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.text}</p></div></li>)}
        </ol>
      </section>
      <section className="trade-announcements" aria-label="Trade updates">
        <h2>Trade updates</h2>
        <div className="trade-home-grid">
          {tradeAnnouncements.map((item) => <article key={item.title} className="trade-discovery-card"><p className="trade-kicker">Editorial</p><h3>{item.title}</h3><p>{item.text}</p></article>)}
        </div>
      </section>
    </div>
  )
}
