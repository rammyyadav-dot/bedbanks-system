import Link from 'next/link'
import { ArrowLeft, SearchX } from 'lucide-react'

export default function BookingNotFound() {
  return (
    <div className="supplier-page">
      <section className="panel unavailable-panel">
        <span className="capability-icon"><SearchX size={26} aria-hidden="true" /></span>
        <div>
          <p className="page-eyebrow is-muted"><i />Booking detail</p>
          <h1>Booking not found</h1>
          <p>The booking reference is missing, malformed, or is not available in this supplier workspace.</p>
          <div className="unavailable-actions">
            <Link className="btn btn-primary" href="/bookings"><ArrowLeft size={15} aria-hidden="true" />Back to bookings</Link>
          </div>
        </div>
      </section>
    </div>
  )
}
