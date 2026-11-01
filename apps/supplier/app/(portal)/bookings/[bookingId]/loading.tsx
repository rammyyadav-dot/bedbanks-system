export default function BookingDetailLoading() {
  return (
    <div className="supplier-page" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading booking details…</span>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-card" />
      <div className="skeleton skeleton-table" />
    </div>
  )
}
