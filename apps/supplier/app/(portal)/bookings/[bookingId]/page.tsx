import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader } from '../../../../components/ui/PageHeader'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { SupplyWorkflowUnavailable } from '../../../../components/supply/SupplyWorkflowUnavailable'
import { getBooking, SupplierApiError } from '../../../../lib/supplier-api'
import { loadPortal } from '../../../../lib/portal'
import { formatNetMinor, NET_STATUS_LABEL, NOT_RECORDED } from '../../../../lib/format'

export default async function BookingDetailPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const portal = await loadPortal()
  if (portal.kind !== 'ready' || !portal.organization) return null
  if (!portal.permissions.includes('supplier.extranet.bookings.read')) {
    return <SupplyWorkflowUnavailable eyebrow="Operations" title="Booking" description="This membership cannot read bookings." />
  }
  const { bookingId } = await params
  try {
    const booking = await getBooking(bookingId)
    return (
      <div className="supplier-page">
        <Link className="back-link" href="/bookings">Back to bookings</Link>
        <PageHeader eyebrow="Read only" title={booking.reference} description="This page shows the booking as recorded. It cannot confirm, reject or change it, and no supplier is contacted from here." />
        <section className="panel">
          <div className="form-section">
            <div className="form-grid">
              <label>Status<span><StatusBadge>{booking.status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</StatusBadge></span></label>
              <label>Hotel<input value={booking.hotelName ?? NOT_RECORDED} readOnly /></label>
              <label>Arrival<input value={booking.checkIn ?? NOT_RECORDED} readOnly /></label>
              <label>Departure<input value={booking.checkOut ?? NOT_RECORDED} readOnly /></label>
              <label>Nights<input value={booking.nights === null ? NOT_RECORDED : String(booking.nights)} readOnly /></label>
              <label>Lead guest<input value={booking.leadGuestName ?? NOT_RECORDED} readOnly /></label>
              <label>Your reference<input value={booking.supplierRef ?? NOT_RECORDED} readOnly /></label>
              <label>Hotel confirmation number<input value={booking.hotelConfirmationNo ?? NOT_RECORDED} readOnly /></label>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table">
              <caption style={{ textAlign: 'left', padding: 16 }}>Rooms and your net amount per room</caption>
              <thead><tr><th>#</th><th>Room</th><th>Board</th><th>Rooms</th><th>Guests</th><th>Net</th></tr></thead>
              <tbody>
                {booking.rooms.length === 0 && <tr><td colSpan={6}>No room lines are recorded.</td></tr>}
                {booking.rooms.map((room) => (
                  <tr key={room.position}>
                    <td>{room.position}</td>
                    <td>{room.roomName ?? NOT_RECORDED}</td>
                    <td>{room.boardCode ?? NOT_RECORDED}</td>
                    <td>{room.quantity}</td>
                    <td>{room.adults} adults{room.children > 0 ? `, ${room.children} children` : ''}</td>
                    <td>{formatNetMinor(room.netMinor, booking.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={5} scope="row">Booking net ({NET_STATUS_LABEL[booking.netStatus]})</th>
                  <td>{booking.netStatus === 'RECORDED' ? formatNetMinor(booking.netMinor, booking.currency) : NOT_RECORDED}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {booking.netStatus === 'MISMATCH' && <p role="status" style={{ padding: 16 }}>The room amounts do not match the stored booking total, so no total is shown. Contact support quoting {booking.reference}.</p>}
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 404) notFound()
    return <SupplyWorkflowUnavailable eyebrow="Operations" title="Booking" description="The booking could not be loaded. No substitute data is shown." />
  }
}
