import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/common/PageHeader'
import { getBooking } from '@/lib/data'

export default async function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const booking = await getBooking(id)
  if (!booking) notFound()

  const rows: [string, string][] = [
    ['Guest', booking.guest ?? '—'],
    ['Hotel', booking.hotel],
    ['Supplier', booking.supplier],
    ['Supplier Reference', booking.supplierReference ?? '—'],
    ['Cost', booking.cost ? `${booking.currency} ${booking.cost.toFixed(2)}` : '—'],
    ['Sell', `${booking.currency} ${booking.amount.toFixed(2)}`],
    ['Margin', booking.margin ? `${booking.currency} ${booking.margin.toFixed(2)}` : '—'],
    ['Payment', 'Wallet — Confirmed (mock)'],
    ['Cancellation', 'Free until 48h before check-in (mock policy)'],
    ['Voucher', 'Issued (mock)'],
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow={`BOOKING · ${booking.tenant}`} title={booking.reference} description={`${booking.checkIn} → ${booking.checkOut}`} />
      <div className="workspace-panel">
        {rows.map(([label, value]) => (
          <div key={label} className="admin-drawer-field" style={{ padding: '13px 18px' }}><span>{label}</span><span>{value}</span></div>
        ))}
      </div>
      <div className="workspace-panel" style={{ marginTop: 16, padding: 18 }}>
        <div style={{ fontSize: 10, color: '#8ba0a5', marginBottom: 10, fontFamily: "'Courier New', monospace" }}>TIMELINE (MOCK)</div>
        {['Booking created', 'Supplier confirmed', 'Voucher issued'].map((step, i) => (
          <div key={step} style={{ padding: '8px 0', fontSize: 12, color: '#2c4a55' }}>{i + 1}. {step}</div>
        ))}
      </div>
    </div>
  )
}
