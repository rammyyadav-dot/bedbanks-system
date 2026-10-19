import Link from 'next/link'
import { PageHeader } from '../../../components/ui/PageHeader'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'
import { listBookings } from '../../../lib/supplier-api'
import { loadPortal } from '../../../lib/portal'
import { formatNetMinor, NET_STATUS_LABEL } from '../../../lib/format'
import { bookingFilters, BOOKING_STATUS_OPTIONS, filtersToQuery } from '../../../lib/booking-filters'

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const portal = await loadPortal()
  if (portal.kind !== 'ready') return null
  if (!portal.organization) {
    return <SupplyWorkflowUnavailable eyebrow="Operations" title="Bookings" description="No supplier organization is available for this account." />
  }
  if (!portal.permissions.includes('supplier.extranet.bookings.read')) {
    return <SupplyWorkflowUnavailable eyebrow="Operations" title="Bookings" description="This membership cannot read bookings." />
  }
  const filters = bookingFilters(await searchParams)
  try {
    const result = await listBookings({ ...filters.values, limit: 25 })
    const nextHref = result.nextCursor ? `/bookings?${filtersToQuery({ ...filters.values, cursor: result.nextCursor })}` : null
    return (
      <div className="supplier-page">
        <PageHeader eyebrow="Operations" title="Bookings" description="Bookings placed on your organization's contracted inventory. Open a booking to answer it when it awaits your answer. Amounts are your net per room; a missing figure is shown as Not recorded." />
        <section className="panel">
          <form method="get" action="/bookings" className="form-grid" style={{ padding: 16 }}>
            <label>Reference starts with<input name="reference" defaultValue={filters.values.reference ?? ''} maxLength={40} /></label>
            <label>Status
              <select name="status" defaultValue={filters.values.status ?? ''}>
                <option value="">All</option>
                {BOOKING_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status.replace(/_/g, ' ').toLowerCase()}</option>)}
              </select>
            </label>
            <label>Arrival from<input type="date" name="checkInFrom" defaultValue={filters.values.checkInFrom ?? ''} /></label>
            <label>Arrival to<input type="date" name="checkInTo" defaultValue={filters.values.checkInTo ?? ''} /></label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
              <button className="btn btn-primary" type="submit">Filter</button>
              <Link className="btn" href="/bookings">Clear</Link>
            </div>
          </form>
          {filters.ignored.length > 0 && <p role="status" style={{ padding: '0 16px' }}>Ignored invalid filter: {filters.ignored.join(', ')}.</p>}
          <div className="table-wrap">
            <table className="data-table"><caption className="sr-only">Bookings</caption>
              <thead><tr><th>Reference</th><th>Hotel</th><th>Stay</th><th>Lead guest</th><th>Status</th><th>Net</th></tr></thead>
              <tbody>
                {result.bookings.length === 0 && <tr><td colSpan={6}>No bookings match.</td></tr>}
                {result.bookings.map((booking) => (
                  <tr key={booking.id}>
                    <td><Link href={`/bookings/${booking.id}`}>{booking.reference}</Link>{booking.supplierRef && <small>Your ref {booking.supplierRef}</small>}</td>
                    <td>{booking.hotelName ?? 'Not recorded'}</td>
                    <td>{booking.checkIn ?? 'Not recorded'} to {booking.checkOut ?? 'Not recorded'}{booking.nights !== null && <small>{booking.nights} nights</small>}</td>
                    <td>{booking.leadGuestName ?? 'Not recorded'}</td>
                    <td><StatusBadge>{booking.status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</StatusBadge></td>
                    <td>{booking.netStatus === 'RECORDED' ? formatNetMinor(booking.netMinor, booking.currency) : NET_STATUS_LABEL[booking.netStatus]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextHref && <p style={{ padding: 16 }}><Link className="btn" href={nextHref}>Next page</Link></p>}
        </section>
      </div>
    )
  } catch {
    return <SupplyWorkflowUnavailable eyebrow="Operations" title="Bookings" description="Bookings could not be loaded. No substitute data is shown." />
  }
}
