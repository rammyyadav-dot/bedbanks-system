'use client'

import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { bookingReviewStay, formatOfferExpiry, recheckedTotalText } from '@/lib/format'
import { stayOccupancyLabel } from '@/lib/search-summary'

/** Commercial review of a rechecked offer. It does not create a hold or a booking. */
export function BookingReview({
  hotelName, destination, starRating, roomName, rate, request, recheckedMinor, bookingEnabled, expiresAt, timeZone,
}: {
  hotelName: string
  destination: string
  starRating: number
  roomName: string
  rate: SearchRateOffer
  request: SearchCriteria
  recheckedMinor: number
  bookingEnabled: boolean
  /** The server's expiry from the recheck result (the search offer's expiry when the recheck did not repeat it). */
  expiresAt?: string
  timeZone?: string
}) {
  const stars = Number.isInteger(starRating) && starRating >= 1 && starRating <= 5 ? `${starRating} star` : null
  const expiry = formatOfferExpiry(expiresAt ?? rate.expiresAt, timeZone)
  // With booking disabled the journey ends here: this is a price-and-availability recheck, not the start of a booking.
  const heading = bookingEnabled ? 'Booking review' : 'Rechecked offer'
  return <section className="booking-review" aria-label={heading}>
    <h3>{heading}</h3>
    <p>{bookingEnabled ? 'This total is the rechecked stay price. The search quote is not the booking price.' : 'This is the authoritative rechecked price and availability for this offer. The search quote is not this price.'}</p>
    <dl>
      <div><dt>Hotel</dt><dd>{hotelName}{stars ? ` · ${stars}` : ''} · {destination}</dd></div>
      <div><dt>Stay</dt><dd>{bookingReviewStay(request.checkIn, request.checkOut)}</dd></div>
      <div><dt>Occupancy</dt><dd>{stayOccupancyLabel(request.rooms, request.adults, request.children, request.childAges)}</dd></div>
      <div><dt>Room</dt><dd>{roomName}</dd></div>
      <div><dt>Board</dt><dd>{rate.boardBasisName}</dd></div>
      <div><dt>Rate plan</dt><dd>{rate.ratePlanName}</dd></div>
      <div><dt>Rechecked total</dt><dd>{recheckedTotalText(recheckedMinor, rate.total.currency)}</dd></div>
      <div><dt>Cancellation</dt><dd>{rate.cancellation.summary}{rate.cancellation.deadline ? ` · until ${rate.cancellation.deadline}` : ''}</dd></div>
      <div><dt>Offer</dt><dd>Rechecked{expiry ? ` · valid until ${expiry}` : ''}</dd></div>
    </dl>
    {bookingEnabled ? <p className="booking-note">Hold and booking stay on the next step. A hold is not a confirmed booking.</p> : <p className="booking-note" role="status">Booking is not enabled for this workspace. This recheck holds no inventory and creates no booking, hold or payment.</p>}
  </section>
}
