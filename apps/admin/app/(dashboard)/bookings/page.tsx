'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { AttentionTags, Money, Tag, bookingTone, when } from '@/components/ops/ops-ui'
import { getOpsBookings } from '@/lib/data/operations'
import type { BookingRow } from '@bedbanks/contracts'

export default function BookingsPage() {
  return (
    <OpsListPage<BookingRow>
      eyebrow="BOOKINGS" title="Bookings" description="Authoritative booking records for the active tenant, with server-evaluated consistency flags. Read-only."
      filters={[
        { key: 'status', label: 'Status', type: 'select', options: ['PENDING', 'CONFIRMED', 'CANCELLED', 'FAILED'].map(v => ({ value: v, label: v })) },
        { key: 'reference', label: 'Reference prefix', type: 'text', placeholder: 'e.g. FB-' },
        { key: 'createdFrom', label: 'Created from', type: 'date' }, { key: 'createdTo', label: 'Created to', type: 'date' },
        { key: 'checkInFrom', label: 'Check-in from', type: 'date' }, { key: 'checkInTo', label: 'Check-in to', type: 'date' },
        { key: 'attention', label: 'Needs attention', type: 'checkbox' },
      ]}
      load={getOpsBookings} getRowId={b => b.id}
      emptyTitle="No bookings match" emptyDescription="The query succeeded and no booking matches these filters."
      columns={[
        { key: 'reference', header: 'Reference', render: b => <Link href={`/bookings/${b.id}`} style={{ fontWeight: 600 }}>{b.reference}</Link> },
        { key: 'status', header: 'Status', render: b => <Tag tone={bookingTone(b.status)}>{b.status}</Tag> },
        { key: 'hotel', header: 'Hotel', render: b => b.hotelName ?? b.hotelId },
        { key: 'stay', header: 'Stay', render: b => (b.checkIn && b.checkOut ? `${b.checkIn} → ${b.checkOut}` : '—') },
        { key: 'total', header: 'Total', align: 'right', render: b => <Money minor={b.totalMinor} currency={b.currency} /> },
        { key: 'supplier', header: 'Supplier', render: b => b.supplier },
        { key: 'attention', header: 'Attention', render: b => <AttentionTags flags={b.attention} /> },
        { key: 'created', header: 'Created', render: b => when(b.createdAt) },
      ]}
    />
  )
}
