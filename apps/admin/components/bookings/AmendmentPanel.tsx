'use client'

import type { BookingDetailView } from '@bedbanks/contracts'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { describeProposal } from '@/lib/booking-amendment-ui'

const muted: React.CSSProperties = { color: 'var(--c-3f565c)', fontSize: 12 }
const tone = (s: string) => (s === 'APPROVED' ? 'ok' : s === 'REJECTED' ? 'neutral' : 'warn') as 'ok' | 'neutral' | 'warn'

/** Every structured amendment of the booking, newest first: what was asked, the booking as it was, and, once approved, the recorded price and difference. Display only. */
export function AmendmentPanel({ d }: { d: BookingDetailView }) {
  const list = d.amendments ?? []
  if (list.length === 0) return <div className="workspace-panel" style={{ padding: 16 }}><p style={muted}>This booking has no structured amendments.</p></div>
  const currency = d.pricing.currency
  return (
    <div style={{ display: 'grid', gap: 10 }} data-testid="amendment-panel">
      {list.map((a) => (
        <section key={a.id} className="workspace-panel" style={{ padding: 14 }} aria-label={`Amendment ${a.status}`} data-testid="amendment-item" data-status={a.status}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Tag tone={tone(a.status)}>{a.status === 'REQUESTED' ? 'AWAITING DECISION' : a.status}</Tag>
            <span style={muted}>Requested {when(a.requestedAt)}{a.decidedAt ? ` · decided ${when(a.decidedAt)}` : ''} · booking version {a.fromVersion}</span>
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>{describeProposal(a).map((line) => <li key={line}>{line}</li>)}</ul>
          {a.approved && (
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 12px', fontSize: 12, margin: '8px 0 0' }}>
              <dt>Price before → after</dt><dd><Money minor={a.before.sellMinor} currency={currency} /> → <Money minor={a.approved.sellMinor} currency={currency} /></dd>
              <dt>Difference</dt><dd>{a.approved.direction === 'NONE' ? 'None' : <>{a.approved.direction === 'INCREASE' ? '+' : '−'}<Money minor={a.approved.differenceMinor.replace('-', '')} currency={currency} /></>}{a.financeRecorded ? <> <Tag tone="neutral">AWAITING FINANCE BOOKING</Tag></> : null}</dd>
              {a.approved.netMinor !== null && <><dt>Net after</dt><dd><Money minor={a.approved.netMinor} currency={currency} /></dd></>}
              <dt>Free-cancellation deadline</dt><dd>{a.approved.cancelDeadline ? when(a.approved.cancelDeadline) : <span style={muted}>unknown: set it when the supplier confirms</span>}</dd>
            </dl>
          )}
          {a.documentsNotReissued.length > 0 && <p style={{ ...muted, fontSize: 11, margin: '8px 0 0' }}>Not reissued: {a.documentsNotReissued.join(', ').toLowerCase()}. These documents still show the figures from before this amendment.</p>}
        </section>
      ))}
    </div>
  )
}
