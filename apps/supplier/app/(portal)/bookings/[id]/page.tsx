import Link from 'next/link'
import { ArrowLeft, Download, Hotel, Mail, ShieldCheck } from 'lucide-react'
import { notFound } from 'next/navigation'
import { PageHeader } from '../../../../components/ui/PageHeader'
import { StatusBadge } from '../../../../components/ui/StatusBadge'
import { getSupplierAdapter } from '../../../../lib/adapter'
import { formatMoney } from '../../../../lib/format'

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const booking = (await getSupplierAdapter().listBookings()).find((item) => item.id === id)
  if (!booking) notFound()
  return <div className="supplier-page"><Link className="back-link" href="/bookings"><ArrowLeft size={12} /> Back to bookings</Link><PageHeader eyebrow="Reservation detail · Masked data" title={booking.id} description="Operational booking view with guest identity intentionally excluded from UI preview data." actions={<button className="btn"><Download size={13} /> Download voucher preview</button>} />
    <div className="booking-detail-grid"><section className="panel"><div className="detail-hero"><span><Hotel size={30} /></span><div><StatusBadge>{booking.status}</StatusBadge><h2>{booking.property}</h2><p>{booking.arrival} – {booking.departure}</p></div><div className="completion-score"><strong>{formatMoney(booking.payableMinor, booking.currency)}</strong><small>supplier payable</small></div></div><div className="booking-facts"><div><small>ROOM / BOARD</small><strong>{booking.room}</strong></div><div><small>OCCUPANCY</small><strong>2 adults · identity masked</strong></div><div><small>SUPPLIER REFERENCE</small><strong>MHG•••1842</strong></div><div><small>CANCELLATION</small><strong>Policy preview only</strong></div></div></section><aside className="panel booking-actions"><h3>Operational actions</h3><button><Mail size={14} /><span><strong>Message operations</strong><small>UI placeholder</small></span></button><button><Download size={14} /><span><strong>Voucher preview</strong><small>No live document</small></span></button><div><ShieldCheck size={15} /><span><strong>Privacy protected</strong><small>No guest PII in mock data</small></span></div></aside></div>
  </div>
}
