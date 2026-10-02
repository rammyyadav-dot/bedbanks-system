'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { BookingService, type BookingSummary } from '@/services/booking-service'
import { agentFacingBooking } from '@/lib/booking-attention'
import { SearchCriteriaForm } from '@/components/search/search-criteria-form'
import { contactEmail, dubaiSpotlight, editorialDestinations, howItWorks, marketplaceHome, privacyLink, tradeAnnouncements } from '@/lib/marketplace-content'
import { guestMarketName } from '@/lib/guest-market'
import { formatStay } from '@/lib/format'
import type { DestinationRef, SearchSort } from '@bedbanks/domain'
import { type RoomStayDraft } from '@/lib/occupancy'
import { canReplayRecentSearch, deleteRecentSearch, readRecentSearches, recentSearchIdentity, type RecentSearch } from '@/lib/recent-searches'
import { activeFilterLabel, stayOccupancyLabel } from '@/lib/search-summary'

export function AgentHome({
  userId,
  destination, destinationRef, setDestination, checkIn, setCheckIn, checkOut, setCheckOut,
  roomStays, setRoomStays, currency, setCurrency, sort, setSort,
  nationality, setNationality, starRatings, setStarRatings, refundableOnly, setRefundableOnly,
  minPrice, setMinPrice, maxPrice, setMaxPrice, boardBasisIds, setBoardBasisIds, propertyTypes, setPropertyTypes,
  boards, propertyTypeOptions,   searching, searchFailed, tenantId, bookingEnabled, onOpenBookings, onSearch, onSearchDubai, onChange, onReplay,
}: {
  userId: string
  destination: string
  destinationRef: DestinationRef | null
  setDestination: (label: string, ref: DestinationRef | null, cityName: string) => void
  checkIn: string
  setCheckIn: (value: string) => void
  checkOut: string
  setCheckOut: (value: string) => void
  roomStays: RoomStayDraft[]
  setRoomStays: (value: RoomStayDraft[]) => void
  currency: string
  setCurrency: (value: string) => void
  sort: SearchSort
  setSort: (value: SearchSort) => void
  nationality: string
  setNationality: (value: string) => void
  starRatings: number[]
  setStarRatings: (value: number[]) => void
  refundableOnly: boolean
  setRefundableOnly: (value: boolean) => void
  minPrice: string
  setMinPrice: (value: string) => void
  maxPrice: string
  setMaxPrice: (value: string) => void
  boardBasisIds: string[]
  setBoardBasisIds: (value: string[]) => void
  propertyTypes: string[]
  setPropertyTypes: (value: string[]) => void
  boards: { id: string; name: string }[]
  propertyTypeOptions: string[]
  searching: boolean
  searchFailed: boolean
  tenantId: string
  bookingEnabled: boolean
  onOpenBookings: () => void
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
        destination={destination} destinationRef={destinationRef} setDestination={setDestination} checkIn={checkIn} setCheckIn={setCheckIn} checkOut={checkOut} setCheckOut={setCheckOut}
        roomStays={roomStays} setRoomStays={setRoomStays} currency={currency} setCurrency={setCurrency}
        nationality={nationality} setNationality={setNationality} starRatings={starRatings} setStarRatings={setStarRatings} refundableOnly={refundableOnly} setRefundableOnly={setRefundableOnly}
        minPrice={minPrice} setMinPrice={setMinPrice} maxPrice={maxPrice} setMaxPrice={setMaxPrice} boardBasisIds={boardBasisIds} setBoardBasisIds={setBoardBasisIds} propertyTypes={propertyTypes} setPropertyTypes={setPropertyTypes}
        boards={boards} propertyTypeOptions={propertyTypeOptions} sort={sort} setSort={setSort}
        searching={searching} searchFailed={searchFailed} onSubmit={onSearch} onChange={onChange} tenantId={tenantId}
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
                  {canReplayRecentSearch(item) ? <button type="button" className="portal-link" onClick={() => onReplay(item)}>Search again →</button> : <span>This saved search can no longer be replayed.</span>}
                  <button type="button" className="portal-link market-delete" onClick={() => remove(item)} aria-label={`Delete ${item.destination} search`}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ReservationStrip enabled={bookingEnabled} tenantId={tenantId} onOpen={onOpenBookings} />
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

function ReservationStrip({ enabled, tenantId, onOpen }: { enabled: boolean; tenantId: string; onOpen: () => void }) {
  const [rows, setRows] = useState<BookingSummary[] | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!enabled) return
    let active = true
    void new BookingService().list(tenantId, { limit: 20 }).then((result) => {
      if (!active) return
      if (result.ok) setRows(result.data.items.filter((row) => row.status === 'PENDING' || row.status === 'CONFIRMED').slice(0, 3))
      else setNote(result.kind === 'unavailable' ? 'Booking is not enabled. No reservations are shown.' : 'Reservations could not be loaded.')
    })
    return () => { active = false }
  }, [enabled, tenantId])
  return <section className="market-recent" aria-label="Reservations">
    <div className="market-section-head"><h2>Reservations</h2>{enabled && <button type="button" className="portal-link" onClick={onOpen}>My bookings</button>}</div>
    {!enabled && <p className="trade-muted">Booking is not enabled. No reservations are shown on this page.</p>}
    {enabled && note && <p className="trade-muted" role="status">{note}</p>}
    {enabled && !note && rows === null && <p className="trade-muted" role="status">Loading reservations…</p>}
    {enabled && rows !== null && rows.length === 0 && <p className="trade-muted">No pending or confirmed bookings in the latest page.</p>}
    {rows !== null && rows.length > 0 && <ul className="market-recent-grid">{rows.map((row) => <li key={row.id}><strong>{row.reference}</strong><span>{row.hotelName ?? 'Hotel'}</span><span>{agentFacingBooking(row.status).label}</span></li>)}</ul>}
  </section>
}
