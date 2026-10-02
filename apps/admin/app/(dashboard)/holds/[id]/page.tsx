'use client'

import Link from 'next/link'
import { use } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { getOpsHold } from '@/lib/data/operations'

export default function HoldDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { state, reload } = useOpsQuery(() => getOpsHold(id), [id])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="INVENTORY HOLD" title="Inventory hold" description="Night-by-night inventory protected by this hold, against the live availability row. Read-only." actions={<Link href="/holds" className="admin-btn">All holds</Link>} />
      <OpsState state={state} onRetry={reload}>
        {h => (
          <div className="workspace-panel" data-testid="hold-detail">
            <section style={{ padding: '12px 18px' }}>
              <h2><code>{h.id}</code> <Tag>{h.status}</Tag></h2>
              <p>{h.hotelName ?? h.hotelId} · {h.roomName ?? h.roomTypeId} · {h.checkIn} → {h.checkOut} · {h.rooms} room(s) · <Money minor={h.sellAmountMinor} currency={h.currency} /></p>
              <p>Created {when(h.createdAt)} · expires {when(h.expiresAt)}{h.releasedAt ? ` · released ${when(h.releasedAt)}` : ''} · request <code>{h.requestId}</code></p>
              <p>{h.booking ? <>Booking <Link href={`/bookings/${h.booking.id}`}>{h.booking.reference}</Link> ({h.booking.status})</> : 'No booking is linked to this hold.'}</p>
              <table style={{ width: '100%', fontSize: 11 }}>
                <thead><tr><th scope="col" align="left">Night</th><th scope="col" align="right">Held qty</th><th scope="col" align="right">Allotment</th><th scope="col" align="right">Sold</th><th scope="col" align="right">Held (all)</th><th scope="col" align="right">Remaining</th><th scope="col" align="left">Stop-sell</th></tr></thead>
                <tbody>{h.nights.map(n => <tr key={n.stayDate}><td>{n.stayDate}</td><td align="right">{n.quantity}</td><td align="right">{n.allotment ?? '—'}</td><td align="right">{n.sold ?? '—'}</td><td align="right">{n.held ?? '—'}</td><td align="right">{n.remaining ?? '—'}</td><td>{n.stopSell === null ? '—' : n.stopSell ? 'YES' : 'no'}</td></tr>)}</tbody>
              </table>
              <h3>Audit</h3>
              {h.audit.length === 0 ? <p>No audit events recorded.</p> : <ol>{h.audit.map(a => <li key={a.id}>{when(a.at)} · <code>{a.action}</code>{a.requestId ? ` · request ${a.requestId}` : ''}</li>)}</ol>}
            </section>
          </div>
        )}
      </OpsState>
    </div>
  )
}
