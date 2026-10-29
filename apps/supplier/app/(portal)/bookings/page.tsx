import Link from 'next/link'
import { BellRing, Boxes, ChevronRight, CircleCheck, Search } from 'lucide-react'
import { EmptyState } from '../../../components/ui/EmptyState'
import { Pager } from '../../../components/ui/Pager'
import { SummaryStrip } from '../../../components/ui/SummaryStrip'
import { isAwaitingConfirmation, statusLabel } from '../../../lib/status'
import { PageHeader } from '../../../components/ui/PageHeader'
import { StatusBadge } from '../../../components/ui/StatusBadge'
import { SupplyWorkflowUnavailable } from '../../../components/supply/SupplyWorkflowUnavailable'
import { listBookings } from '../../../lib/supplier-api'
import { loadPortal } from '../../../lib/portal'
import { formatNetMinor, NET_STATUS_LABEL, NOT_RECORDED } from '../../../lib/format'
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
    const awaiting = result.bookings.filter((booking) => isAwaitingConfirmation(booking.status)).length
    const confirmed = result.bookings.filter((booking) => booking.status === 'CONFIRMED').length
    const filtered = Boolean(filters.values.reference || filters.values.status || filters.values.checkInFrom || filters.values.checkInTo)
    return (
      <div className="supplier-page">
        <PageHeader eyebrow="Operations" title="Bookings" description="Bookings placed on your organization's contracted inventory, read only. fBeds confirms them and settles the agency's payment; answering from here is not available yet. Amounts are your net per room; a missing figure is shown as Not recorded." />
        <SummaryStrip items={[
          { label: 'Bookings on this page', value: String(result.bookings.length), hint: nextHref ? 'More on the next page' : 'End of list', icon: Boxes, tone: 'blue' },
          { label: 'Awaiting confirmation', value: String(awaiting), hint: 'On this page', icon: BellRing, tone: 'amber' },
          { label: 'Confirmed', value: String(confirmed), hint: 'On this page', icon: CircleCheck, tone: 'green' },
        ]} />
        <section className="panel">
          <form method="get" action="/bookings" className="filter-form">
            <label className="filter-field"><span>Reference starts with</span><input name="reference" defaultValue={filters.values.reference ?? ''} maxLength={40} placeholder="e.g. FB-2026" /></label>
            <label className="filter-field"><span>Status</span>
              <select name="status" defaultValue={filters.values.status ?? ''}>
                <option value="">All statuses</option>
                {BOOKING_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
              </select>
            </label>
            <label className="filter-field"><span>Arrival from</span><input type="date" name="checkInFrom" defaultValue={filters.values.checkInFrom ?? ''} /></label>
            <label className="filter-field"><span>Arrival to</span><input type="date" name="checkInTo" defaultValue={filters.values.checkInTo ?? ''} /></label>
            <div className="filter-actions">
              <button className="btn btn-primary" type="submit"><Search size={15} aria-hidden="true" />Filter</button>
              {filtered && <Link className="btn" href="/bookings">Clear</Link>}
            </div>
          </form>
          {filters.ignored.length > 0 && <p className="inline-notice" role="status">Ignored invalid filter: {filters.ignored.join(', ')}.</p>}
          {result.bookings.length === 0 ? (
            <EmptyState icon={Boxes} title="No bookings match">{filtered ? 'Try widening the dates or clearing the filters.' : 'Bookings appear here when they are placed on your inventory.'}</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table"><caption className="sr-only">Bookings</caption>
                <thead><tr><th>Reference</th><th>Hotel</th><th>Stay</th><th>Lead guest</th><th>Status</th><th className="num">Net</th><th><span className="sr-only">Action</span></th></tr></thead>
                <tbody>
                  {result.bookings.map((booking) => {
                    const waiting = isAwaitingConfirmation(booking.status)
                    return (
                      <tr key={booking.id} className={waiting ? 'row-attention' : undefined}>
                        <td><Link href={`/bookings/${booking.id}`}>{booking.reference}</Link>{booking.supplierRef && <small>Your ref {booking.supplierRef}</small>}</td>
                        <td>{booking.hotelName ?? NOT_RECORDED}</td>
                        <td className="nowrap">{booking.checkIn ?? NOT_RECORDED} <span className="muted">to</span> {booking.checkOut ?? NOT_RECORDED}{booking.nights !== null && <small>{booking.nights} {booking.nights === 1 ? 'night' : 'nights'}</small>}</td>
                        <td>{booking.leadGuestName ?? NOT_RECORDED}</td>
                        <td><StatusBadge raw={booking.status}>{booking.status}</StatusBadge></td>
                        <td className="num">{booking.netStatus === 'RECORDED' ? formatNetMinor(booking.netMinor, booking.currency) : NET_STATUS_LABEL[booking.netStatus]}</td>
                        <td className="row-end"><Link className="row-link" href={`/bookings/${booking.id}`} aria-label={`Open booking ${booking.reference}`}><ChevronRight size={18} aria-hidden="true" /></Link></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager shown={result.bookings.length} noun="bookings" firstHref={filters.values.cursor ? `/bookings?${filtersToQuery({ ...filters.values, cursor: undefined })}` : null} nextHref={nextHref} />
        </section>
      </div>
    )
  } catch {
    return <SupplyWorkflowUnavailable eyebrow="Operations" title="Bookings" description="Bookings could not be loaded. No substitute data is shown." />
  }
}
