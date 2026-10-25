import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { notFound } from 'next/navigation'
import { BookingAnswerForm } from '../../../../components/bookings/BookingAnswerForm'
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
    const answers = booking.status === 'PENDING_SUPPLIER' ? (['CONFIRMED', 'ON_REQUEST', 'REJECTED'] as const) : booking.status === 'ON_REQUEST' ? (['CONFIRMED', 'REJECTED'] as const) : []
    const canAnswer = portal.permissions.includes('supplier.extranet.bookings.answer') && answers.length > 0
    return (
      <div className="supplier-page">
        <Link className="back-link" href="/bookings"><ArrowLeft size={15} aria-hidden="true" />Back to bookings</Link>
        <PageHeader eyebrow={canAnswer ? 'Awaiting your answer' : 'Booking'} title={booking.reference} description={canAnswer ? 'Review the booking, then confirm it, put it on request or reject it. No other change can be made here.' : 'This page shows the booking as recorded. It cannot be changed from here.'} />
        <section className="panel booking-summary">
          <div className="booking-summary-head">
            <div><small>Status</small></div>
            <StatusBadge raw={booking.status}>{booking.status}</StatusBadge>
          </div>
          <div className="booking-facts">
            <div><small>Hotel</small><strong>{booking.hotelName ?? NOT_RECORDED}</strong></div>
            <div><small>Stay</small><strong>{booking.checkIn ?? NOT_RECORDED} to {booking.checkOut ?? NOT_RECORDED}</strong><span>{booking.nights === null ? NOT_RECORDED : `${booking.nights} ${booking.nights === 1 ? 'night' : 'nights'}`}</span></div>
            <div><small>Lead guest</small><strong>{booking.leadGuestName ?? NOT_RECORDED}</strong></div>
            <div><small>Booking net</small><strong>{booking.netStatus === 'RECORDED' ? formatNetMinor(booking.netMinor, booking.currency) : NET_STATUS_LABEL[booking.netStatus]}</strong></div>
            <div><small>Your reference</small><strong>{booking.supplierRef ?? NOT_RECORDED}</strong></div>
            <div><small>Hotel confirmation no.</small><strong>{booking.hotelConfirmationNo ?? NOT_RECORDED}</strong></div>
          </div>
        </section>
        {canAnswer && (
          <section className="panel answer-panel">
            <BookingAnswerForm bookingId={booking.id} expectedStatus={booking.status} idempotencyKey={randomUUID()} answers={[...answers]} />
          </section>
        )}
        <section className="panel">
          <div className="table-wrap">
            <table className="data-table">
              <caption className="table-caption">Rooms and your net amount per room</caption>
              <thead><tr><th>#</th><th>Room</th><th>Board</th><th>Rooms</th><th>Guests</th><th className="num">Net</th></tr></thead>
              <tbody>
                {booking.rooms.length === 0 && <tr><td colSpan={6}>No room lines are recorded.</td></tr>}
                {booking.rooms.map((room) => (
                  <tr key={room.position}>
                    <td>{room.position}</td>
                    <td>{room.roomName ?? NOT_RECORDED}</td>
                    <td>{room.boardCode ?? NOT_RECORDED}</td>
                    <td>{room.quantity}</td>
                    <td>{room.adults} adults{room.children > 0 ? `, ${room.children} children` : ''}</td>
                    <td className="num">{formatNetMinor(room.netMinor, booking.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={5} scope="row">Booking net ({NET_STATUS_LABEL[booking.netStatus]})</th>
                  <td className="num"><strong>{booking.netStatus === 'RECORDED' ? formatNetMinor(booking.netMinor, booking.currency) : NOT_RECORDED}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
          {booking.netStatus === 'MISMATCH' && <p className="inline-notice warning" role="status">The room amounts do not match the stored booking total, so no total is shown. Contact support quoting {booking.reference}.</p>}
        </section>
      </div>
    )
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 404) notFound()
    return <SupplyWorkflowUnavailable eyebrow="Operations" title="Booking" description="The booking could not be loaded. No substitute data is shown." />
  }
}
