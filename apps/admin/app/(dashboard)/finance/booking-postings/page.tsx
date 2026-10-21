'use client'

import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getBookingPostingBacklog } from '@/lib/data/booking-finance-postings'
import { eventText, nextRetryAt, reviewText, skipText } from '@/lib/booking-finance-posting-ui'

/**
 * Booking postings (ADR 0076): what the Finance consumer did with the money facts of Admin bookings, and what is waiting for a person. Read-only; nothing on this page
 * posts or changes anything. A failed read is shown as a failure, never as an empty backlog.
 */
export default function BookingPostingsPage() {
  const q = useOpsQuery(() => getBookingPostingBacklog(), [])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · BOOKING POSTINGS" title="Booking postings" description="Money facts of Admin bookings and what the Finance consumer did with them: charged to the agency, accrued to the supplier, skipped, or waiting for a person. Read-only." />
      <OpsState state={q.state} onRetry={q.reload}>
        {(d) => (
          <div className="workspace-panel" data-testid="booking-postings">
            <dl style={{ display: 'flex', gap: 24, padding: '10px 14px', margin: 0, flexWrap: 'wrap' }} aria-label="Posting counts">
              {([['Posted', d.counts.posted], ['Skipped (no money to move)', d.counts.skipped], ['Needs a person', d.counts.reviewRequired], ['Waiting', d.counts.waiting]] as const).map(([label, n]) => (
                <div key={label}><dt style={{ fontSize: 11, color: '#3f565c' }}>{label}</dt><dd style={{ margin: 0, fontSize: 20, fontWeight: 600 }} data-testid={`count-${label.split(' ')[0].toLowerCase()}`}>{n}</dd></div>
              ))}
            </dl>

            <h2 style={{ fontSize: 13, padding: '6px 14px 0' }}>Needs a person</h2>
            {d.review.length === 0
              ? <p style={{ fontSize: 12, padding: '0 14px' }} data-testid="review-empty">Nothing needs a person. The query succeeded and no event is in review.</p>
              : (
                <ScrollRegion label="Events that need a person">
                  <table style={tableStyle} aria-label="Events that need a person">
                    <thead><tr>{['Booking', 'Event', 'Amount', 'What is wrong', 'What to do', 'Attempts', 'Next retry'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                    <tbody>{d.review.map((r) => {
                      const t = reviewText(r.reason)
                      return (
                        <tr key={r.eventId}>
                          <td style={td}><Link href={`/bookings/${encodeURIComponent(r.bookingId)}`}>Open booking</Link></td>
                          <td style={td}>{eventText(r.eventType)}<br /><span style={{ fontSize: 10 }}>{when(r.recordedAt)}</span></td>
                          <td style={{ ...td, textAlign: 'right' }}><Money minor={r.sellMinor} currency={r.currency} /></td>
                          <td style={td}><Tag tone="warn">{t.title}</Tag></td>
                          <td style={td}>{t.action}</td>
                          <td style={td}>{r.attempts}</td>
                          <td style={td}>{when(nextRetryAt(r.lastAttemptAt))}</td>
                        </tr>
                      )
                    })}</tbody>
                  </table>
                </ScrollRegion>
              )}
            {d.counts.reviewRequired > d.review.length && <p style={{ fontSize: 11, padding: '4px 14px' }}>Showing the oldest {d.review.length} of {d.counts.reviewRequired}.</p>}

            <h2 style={{ fontSize: 13, padding: '10px 14px 0' }}>Waiting</h2>
            {d.waiting.length === 0
              ? <p style={{ fontSize: 12, padding: '0 14px' }} data-testid="waiting-empty">No event is waiting.</p>
              : (
                <ScrollRegion label="Events not yet attempted">
                  <table style={tableStyle} aria-label="Events not yet attempted">
                    <thead><tr>{['Booking', 'Event', 'Amount', 'Recorded'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                    <tbody>{d.waiting.map((w) => (
                      <tr key={w.eventId}>
                        <td style={td}><Link href={`/bookings/${encodeURIComponent(w.bookingId)}`}>Open booking</Link></td>
                        <td style={td}>{eventText(w.eventType)}</td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={w.sellMinor} currency={w.currency} /></td>
                        <td style={td}>{when(w.recordedAt)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </ScrollRegion>
              )}
            {d.counts.waiting > d.waiting.length && <p style={{ fontSize: 11, padding: '4px 14px' }}>Showing the oldest {d.waiting.length} of {d.counts.waiting}. Events behind one that needs a person wait for it.</p>}

            {d.skippedByReason.length > 0 && (
              <details style={{ fontSize: 11, color: '#3f565c', padding: '6px 14px' }}>
                <summary>Why events were skipped</summary>
                <ul>{d.skippedByReason.map((s) => <li key={s.reason}><strong>{s.count}</strong> · {skipText(s.reason)}</li>)}</ul>
              </details>
            )}
            <p style={{ fontSize: 11, color: '#3f565c', padding: '6px 14px' }}>Generated {when(d.generatedAt)}. The consumer runs only where Finance has enabled it for this deployment; an unavailable consumer is shown as a failure above, not as an empty list.</p>
          </div>
        )}
      </OpsState>
    </div>
  )
}
