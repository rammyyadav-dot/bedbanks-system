'use client'

import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { bookingReviewStay, recheckedTotalText } from '@/lib/format'
import { stayOccupancyLabel } from '@/lib/search-summary'

/** Commercial review of a rechecked offer. It does not create a hold or a booking. */
export function BookingReview({
  hotelName, destination, starRating, roomName, rate, request, recheckedMinor, bookingEnabled,
}: {
  hotelName: string
  destination: string
  starRating: number
  roomName: string
  rate: SearchRateOffer
  request: SearchCriteria
  recheckedMinor: number
  bookingEnabled: boolean
}) {
  const stars = Number.isInteger(starRating) && starRating >= 1 && starRating <= 5 ? `${starRating} star` : null
  return <section className="booking-review" aria-label="Booking review">
    <h3>Booking review</h3>
    <p>This total is the rechecked stay price. The search quote is not the booking price.</p>
    <dl>
      <div><dt>Hotel</dt><dd>{hotelName}{stars ? ` · ${stars}` : ''} · {destination}</dd></div>
      <div><dt>Stay</dt><dd>{bookingReviewStay(request.checkIn, request.checkOut)}</dd></div>
      <div><dt>Occupancy</dt><dd>{stayOccupancyLabel(request.rooms, request.adults, request.children, request.childAges)}</dd></div>
      <div><dt>Room</dt><dd>{roomName}</dd></div>
      <div><dt>Board</dt><dd>{rate.boardBasisName}</dd></div>
      <div><dt>Rate plan</dt><dd>{rate.ratePlanName}</dd></div>
      <div><dt>Rechecked total</dt><dd>{recheckedTotalText(recheckedMinor, rate.total.currency)}</dd></div>
      <div><dt>Cancellation</dt><dd>{rate.cancellation.summary}{rate.cancellation.deadline ? ` · until ${rate.cancellation.deadline}` : ''}</dd></div>
      <div><dt>Offer</dt><dd>Rechecked{rate.expiresAt ? ` · offer expires ${rate.expiresAt}` : ''}</dd></div>
    </dl>
    {bookingEnabled ? <p className="booking-note">Hold and booking stay on the next step. A hold is not a confirmed booking.</p> : <p className="booking-note" role="status">Booking is not enabled for this workspace. No inventory hold and no booking will be created.</p>}
  </section>
}
