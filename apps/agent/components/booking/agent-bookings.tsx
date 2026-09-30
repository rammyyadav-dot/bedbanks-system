'use client'

export function Bookings({ onSearch }: { onSearch: () => void }) {
  return <section className="portal-empty"><h1>My bookings</h1><p>Booking history is unavailable until the transactional API is connected.</p><button className="portal-primary" onClick={onSearch}>New search</button></section>
}
