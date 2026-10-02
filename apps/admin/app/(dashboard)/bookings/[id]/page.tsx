'use client'

import Link from 'next/link'
import { use } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { AttentionTags, ATTENTION_HELP, Money, Tag, bookingTone, when } from '@/components/ops/ops-ui'
import { getOpsBooking, opsDocumentUrl } from '@/lib/data/operations'

const section: React.CSSProperties = { padding: '12px 18px', borderBottom: '1px solid #edf2f3' }
const dl: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) 1fr', gap: '4px 12px', margin: 0 }

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { state, reload } = useOpsQuery(() => getOpsBooking(id), [id])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="BOOKING 360" title="Booking" description="Every fact about this booking from the authoritative records. Read-only; documents are immutable." actions={<Link href="/bookings" className="admin-btn">All bookings</Link>} />
      <OpsState state={state} onRetry={reload}>
        {b => (
          <div className="workspace-panel" data-testid="booking-360">
            <section style={section} aria-labelledby="b-summary">
              <h2 id="b-summary">{b.booking.reference} <Tag tone={bookingTone(b.booking.status)}>{b.booking.status}</Tag></h2>
              <dl style={dl}><dt>Created</dt><dd>{when(b.booking.createdAt)}</dd><dt>Updated</dt><dd>{when(b.booking.updatedAt)}</dd></dl>
            </section>
            {b.attention.length > 0 && (
              <section style={{ ...section, background: '#fff7f7' }} aria-labelledby="b-attn" role="region">
                <h3 id="b-attn">Needs attention</h3>
                <AttentionTags flags={b.attention} />
                <ul>{b.attention.map(f => <li key={f}><code>{f}</code> — {ATTENTION_HELP[f]}</li>)}</ul>
                <Link href="/reconciliation">Open reconciliation queue</Link>
              </section>
            )}
            <section style={section} aria-labelledby="b-stay"><h3 id="b-stay">Stay</h3>
              <dl style={dl}><dt>Hotel</dt><dd>{b.stay.hotelName ?? b.stay.hotelId}</dd><dt>Room</dt><dd>{b.stay.roomName ?? '—'}</dd><dt>Board</dt><dd>{b.stay.boardCode ?? '—'}</dd>
                <dt>Dates</dt><dd>{b.stay.checkIn && b.stay.checkOut ? `${b.stay.checkIn} → ${b.stay.checkOut}` : '—'}</dd><dt>Occupancy</dt><dd>{b.stay.rooms ?? '—'} room(s), {b.stay.adults ?? '—'} adult(s), {b.stay.children ?? '—'} child(ren)</dd></dl>
            </section>
            <section style={section} aria-labelledby="b-com"><h3 id="b-com">Commercial snapshot</h3>
              <dl style={dl}><dt>Total</dt><dd><Money minor={b.commercial.totalMinor} currency={b.commercial.currency} /></dd><dt>Offer</dt><dd>{b.commercial.offerId ?? '—'}</dd><dt>Search</dt><dd>{b.commercial.searchId ?? '—'}</dd><dt>Rate plan</dt><dd>{b.commercial.ratePlanId ?? '—'}</dd></dl>
            </section>
            <section style={section} aria-labelledby="b-inv"><h3 id="b-inv">Inventory</h3>
              {b.inventory.hold ? (
                <>
                  <p>Hold <Link href={`/holds/${b.inventory.holdId}`}>{b.inventory.holdId}</Link> · <Tag>{b.inventory.hold.status}</Tag> · expires {when(b.inventory.hold.expiresAt)}{b.inventory.hold.releasedAt ? ` · released ${when(b.inventory.hold.releasedAt)}` : ''}</p>
                  <ul>{b.inventory.hold.nights.map(n => <li key={n.stayDate}>{n.stayDate}: {n.quantity} held · remaining {n.remaining ?? '—'}{n.stopSell ? ' · STOP-SELL' : ''}</li>)}</ul>
                </>
              ) : <p>No inventory hold is linked to this booking.</p>}
            </section>
            <section style={section} aria-labelledby="b-sup"><h3 id="b-sup">Supplier</h3>
              <dl style={dl}><dt>Supplier</dt><dd>{b.supplier.supplier}</dd><dt>Supplier booking reference</dt><dd>Not stored (shown as unavailable, never inferred)</dd>
                <dt>Prebook</dt><dd>{b.supplier.prebook ? `${when(b.supplier.prebook.at)} · request ${b.supplier.prebook.requestId ?? '—'}` : '—'}</dd><dt>Confirmation</dt><dd>{b.supplier.confirmation ? `${when(b.supplier.confirmation.at)} · request ${b.supplier.confirmation.requestId ?? '—'}` : '—'}</dd></dl>
            </section>
            <section style={section} aria-labelledby="b-fin"><h3 id="b-fin">Finance</h3>
              <p>Net ledger effect: <Money minor={b.finance.netMinor} currency={b.commercial.currency} /></p>
              {b.finance.entries.length === 0 ? <p>No ledger entries are recorded for this booking.</p> : (
                <table style={{ width: '100%', fontSize: 11 }}><thead><tr><th scope="col" align="left">When</th><th scope="col" align="left">Type</th><th scope="col" align="right">Amount</th><th scope="col" align="left">Idempotency key</th></tr></thead>
                  <tbody>{b.finance.entries.map(e => <tr key={e.id}><td>{when(e.at)}</td><td>{e.type}</td><td align="right"><Money minor={e.amountMinor} currency={e.currency} /></td><td><code>{e.idempotencyKey}</code></td></tr>)}</tbody></table>
              )}
            </section>
            <section style={section} aria-labelledby="b-can"><h3 id="b-can">Cancellation</h3>
              {b.cancellation.record ? <p>Recorded {when(b.cancellation.record.createdAt)} · reason {b.cancellation.record.reason ?? '—'} · refund recorded <Money minor={b.cancellation.record.refundMinor} currency={b.commercial.currency} /> · refund posted <Money minor={b.cancellation.refundPosted} currency={b.commercial.currency} /></p> : <p>No cancellation record.</p>}
            </section>
            <section style={section} aria-labelledby="b-doc"><h3 id="b-doc">Documents (immutable)</h3>
              {b.documents.length === 0 ? <p>No document has been issued yet. Documents are issued once, on first view in the agent portal; Admin never issues them.</p> : (
                <ul>{b.documents.map(d => <li key={d.type}>{d.type} {d.number} · issued {when(d.issuedAt)} · <a href={opsDocumentUrl(b.booking.id, d.type === 'CREDIT_NOTE' ? 'credit-note' : (d.type.toLowerCase() as 'voucher' | 'invoice'))} target="_blank" rel="noopener noreferrer">View (opens a printable page)</a></li>)}</ul>
              )}
            </section>
            <section style={section} aria-labelledby="b-aud"><h3 id="b-aud">Audit trail</h3>
              {b.audit.length === 0 ? <p>No audit events recorded.</p> : <ol>{b.audit.map(a => <li key={a.id}>{when(a.at)} · <code>{a.action}</code> · {a.actorType}{a.requestId ? ` · request ${a.requestId}` : ''}</li>)}</ol>}
            </section>
          </div>
        )}
      </OpsState>
    </div>
  )
}
