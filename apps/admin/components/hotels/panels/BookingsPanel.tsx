'use client'

import Link from 'next/link'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { AttentionTags, Money, Tag, bookingTone, when } from '@/components/ops/ops-ui'
import { getOpsBookings, getOpsHolds } from '@/lib/data/operations'
import { ScrollRegion, td, th, tableStyle } from '../ui'

/** Links into the existing booking and hold operations, filtered on the server by hotel. Booking 360 is not rebuilt here. */
export function BookingsPanel({ hotelId }: { hotelId: string }) {
  const bookings = useOpsQuery(() => getOpsBookings({ hotelId, pageSize: 25, chip: 'latest' }), [hotelId])
  const holds = useOpsQuery(() => getOpsHolds({ hotelId, pageSize: 10 }), [hotelId])
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="workspace-panel" style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><h2 style={{ fontSize: 14, margin: 0 }}>Bookings</h2><Link href={`/bookings?hotelId=${encodeURIComponent(hotelId)}`}>All bookings for this hotel</Link></div>
        <OpsState state={bookings.state} onRetry={bookings.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No bookings for this hotel', description: 'The query succeeded and this hotel has no bookings.' }}>
          {(data) => (
            <ScrollRegion label="Hotel bookings"><table style={tableStyle} aria-label="Hotel bookings"><thead><tr>{['Reference', 'Status', 'Stay', 'Total', 'Attention', 'Created'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{data.items.map((b) => <tr key={b.id}><td style={td}><Link href={`/bookings/${b.id}`} style={{ fontWeight: 600 }}>{b.reference}</Link></td><td style={td}><Tag tone={bookingTone(b.status)}>{b.status.replace(/_/g, ' ')}</Tag></td><td style={td}>{b.checkIn && b.checkOut ? `${b.checkIn} → ${b.checkOut}` : '—'}</td><td style={td}><Money minor={b.sellMinor} currency={b.currency} /></td><td style={td}>{b.attention === null ? <span style={{ color: '#3f565c' }} title="Reconciliation flags are not readable by the API database role">unavailable</span> : <AttentionTags flags={b.attention} />}</td><td style={td}>{when(b.createdAt)}</td></tr>)}</tbody></table>
              <p style={{ fontSize: 11, color: '#3f565c' }}>{data.total} booking{data.total === 1 ? '' : 's'} in total.</p></ScrollRegion>
          )}
        </OpsState>
      </div>
      <div className="workspace-panel" style={{ padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><h2 style={{ fontSize: 14, margin: 0 }}>Inventory holds</h2><Link href={`/holds?hotelId=${encodeURIComponent(hotelId)}`}>All holds for this hotel</Link></div>
        <OpsState state={holds.state} onRetry={holds.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No holds for this hotel', description: 'The query succeeded and this hotel has no inventory holds.' }}>
          {(data) => (
            <ScrollRegion label="Hotel holds"><table style={tableStyle} aria-label="Hotel holds"><thead><tr>{['Hold', 'Status', 'Room', 'Stay', 'Amount', 'Expires'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{data.items.map((h) => <tr key={h.id}><td style={td}><Link href={`/holds/${h.id}`} style={{ fontWeight: 600 }}>{h.id}</Link></td><td style={td}><Tag tone={h.status === 'HELD' || h.status === 'CONFIRMED' ? 'ok' : h.status === 'PROCESSING' || h.status === 'HOLD_PENDING' ? 'warn' : 'neutral'}>{h.status}</Tag></td><td style={td}>{h.roomName ?? h.roomTypeId}</td><td style={td}>{h.checkIn} → {h.checkOut}</td><td style={td}><Money minor={h.sellAmountMinor} currency={h.currency} /></td><td style={td}>{when(h.expiresAt)}</td></tr>)}</tbody></table></ScrollRegion>
          )}
        </OpsState>
      </div>
    </div>
  )
}
