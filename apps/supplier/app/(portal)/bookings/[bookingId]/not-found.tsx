import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

export default function BookingNotFound() {
  return (
    <main className="supplier-page">
      <section className="panel">
        <p>Booking detail</p>
        <h1>Booking not found</h1>
        <p>The booking reference is missing, malformed, or is not available in this supplier workspace.</p>
        <Link className="btn btn-primary" href="/bookings">
          <ArrowLeft size={13} />
          Back to bookings
        </Link>
      </section>
    </main>
  )
}
