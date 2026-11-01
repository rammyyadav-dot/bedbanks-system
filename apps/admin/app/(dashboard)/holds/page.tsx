'use client'

import Link from 'next/link'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LoadingState } from '@/components/common/LoadingState'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { getOpsHolds } from '@/lib/data/operations'
import type { HoldRow } from '@bedbanks/contracts'

const tone = (s: string) => (s === 'HELD' || s === 'CONFIRMED' ? 'ok' : s === 'PROCESSING' || s === 'HOLD_PENDING' ? 'warn' : s === 'FAILED' ? 'bad' : 'neutral') as 'ok' | 'warn' | 'bad' | 'neutral'

function HoldsPageInner() {
  const hotelId = useSearchParams().get('hotelId') ?? undefined
  return (
    <OpsListPage<HoldRow>
      eyebrow="INVENTORY" title="Inventory holds" description="Holds protect inventory between recheck and booking. A hold stuck in PROCESSING needs reconciliation. Read-only."
      filters={[
        { key: 'status', label: 'Status', type: 'select', options: ['PENDING_RECHECK', 'RECHECKED', 'HOLD_PENDING', 'HELD', 'PROCESSING', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'FAILED'].map(v => ({ value: v, label: v })) },
        { key: 'hotelId', label: 'Hotel id', type: 'text' }, { key: 'from', label: 'Created from', type: 'date' }, { key: 'to', label: 'Created to', type: 'date' },
      ]}
      initial={hotelId ? { hotelId } : undefined} load={getOpsHolds} getRowId={h => h.id}
      emptyTitle="No holds" emptyDescription="The query succeeded and no inventory hold matches these filters."
      columns={[
        { key: 'id', header: 'Hold', render: h => <Link href={`/holds/${h.id}`} style={{ fontWeight: 600 }}>{h.id}</Link> },
        { key: 'status', header: 'Status', render: h => <Tag tone={tone(h.status)}>{h.status}</Tag> },
        { key: 'hotel', header: 'Hotel / room', render: h => `${h.hotelName ?? h.hotelId} · ${h.roomName ?? h.roomTypeId}` },
        { key: 'stay', header: 'Stay', render: h => `${h.checkIn} → ${h.checkOut} (${h.rooms} room${h.rooms === 1 ? '' : 's'})` },
        { key: 'amount', header: 'Amount', align: 'right', render: h => <Money minor={h.sellAmountMinor} currency={h.currency} /> },
        { key: 'booking', header: 'Booking', render: h => (h.booking ? <Link href={`/bookings/${h.booking.id}`}>{h.booking.reference}</Link> : '—') },
        { key: 'expires', header: 'Expires', render: h => when(h.expiresAt) },
      ]}
    />
  )
}

export default function HoldsPage() { return <Suspense fallback={<LoadingState rows={6} />}><HoldsPageInner /></Suspense> }
