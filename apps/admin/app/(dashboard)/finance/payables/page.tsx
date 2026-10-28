'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getSupplierPayables } from '@/lib/data/operations'
import { PAYABLE_AGING_BUCKETS, PAYABLE_DUE_BUCKETS } from '@bedbanks/contracts'
import { termsText } from '@/lib/booking-finance-posting-ui'
import { getPayablesAging, getPayablesDue, getPostedPayables } from '@/lib/data/booking-finance-postings'

/**
 * Supplier payables, slice 1 (ADR 0054). A read-only accrual of recorded supplier net cost for confirmed stays. It is NOT an amount owed:
 * no supplier invoice, payment or settlement exists in the system, and nothing on this page posts or changes anything.
 */
export default function SupplierPayablesPage() {
  const q = useOpsQuery(() => getSupplierPayables(), [])
  const posted = useOpsQuery(() => getPostedPayables(), [])
  const aging = useOpsQuery(() => getPayablesAging(), [])
  const due = useOpsQuery(() => getPayablesDue(), [])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · PAYABLES" title="Supplier payables (accrual)" description="Recorded supplier net cost of confirmed bookings, per supplier and currency. Read-only; not a settlement or an amount owed." />
      <OpsState state={q.state} onRetry={q.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No payable bookings', description: 'The query succeeded and no booking is in a payable state.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="supplier-payables">
            <ScrollRegion label="Supplier payables">
              <table style={tableStyle} aria-label="Supplier payables accrual">
                <thead><tr>{['Supplier', 'Currency', 'Payable bookings', 'With net recorded', 'Net unknown', 'Accrued net cost'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={`${r.supplier}-${r.currency}`}>
                    <td style={td}>{r.supplier}</td><td style={td}>{r.currency}</td><td style={td}>{r.bookings}</td><td style={td}>{r.bookingsWithNet}</td>
                    <td style={td}>{r.bookingsNetUnknown > 0 ? <Tag tone="warn">{r.bookingsNetUnknown} excluded</Tag> : 0}</td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.accruedNetMinor} currency={r.currency} /></td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <details style={{ fontSize: 11, color: 'var(--c-444444)', padding: '6px 14px' }}><summary>What these numbers mean</summary><ul>{Object.entries(d.definitions).map(([k, v]) => <li key={k}><strong>{k}</strong>: {v}</li>)}</ul></details>
          </div>
        )}
      </OpsState>

      <h2 style={{ fontSize: 14, margin: '18px 0 4px' }}>Posted payables (Finance consumer)</h2>
      <p style={{ fontSize: 12, margin: '0 0 8px', color: 'var(--c-444444)' }}>
        What the booking Finance consumer has posted to each supplier: accruals on confirmation, price adjustments, and reversals on penalty-free cancellations (ADR 0076).
        This is a different basis from the accrual above, which reads the bookings themselves and works whether or not the consumer runs; the two can differ until the consumer has posted every booking.
        Neither is an amount to pay: no supplier invoice exists, and payments are only what has been recorded and approved under Supplier settlements.
      </p>
      <OpsState state={posted.state} onRetry={posted.reload} isEmpty={(d) => d.rows.length === 0} empty={{ title: 'Nothing posted yet', description: 'The query succeeded and the Finance consumer has posted no supplier payable entry.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="posted-payables">
            <ScrollRegion label="Posted supplier payables">
              <table style={tableStyle} aria-label="Posted supplier payables">
                <thead><tr>{['Supplier', 'Currency', 'Accruals', 'Adjustments', 'Reversals', 'Balance', 'Paid', 'Outstanding', 'Entries'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.rows.map((r) => (
                  <tr key={`${r.supplierId}-${r.currency}`}>
                    <td style={td}>{r.name ?? 'Unnamed supplier'}</td><td style={td}>{r.currency}</td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.accrualsMinor} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.adjustmentsMinor} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.reversalsMinor} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.balanceMinor} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.paidMinor} currency={r.currency} /></td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.outstandingMinor} currency={r.currency} /></td>
                    <td style={td}>{r.entries}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            {d.truncated && <p style={{ fontSize: 11, padding: '4px 14px' }}>Showing the first {d.listLimit} supplier and currency rows.</p>}
          </div>
        )}
      </OpsState>

      <h2 style={{ fontSize: 14, margin: '18px 0 4px' }}>Age of posted payables</h2>
      <p style={{ fontSize: 12, margin: '0 0 8px', color: 'var(--c-444444)' }}>
        What is still owed on each booking, by the age of its first accrual. There are no payment terms or due dates in the system, so this is how long a cost has been owed, not how late it is. Approved supplier payments are applied to the oldest bookings first.
        Bookings fully reversed or fully adjusted away are not listed.
      </p>
      <OpsState state={aging.state} onRetry={aging.reload} isEmpty={(d) => d.rows.length === 0} empty={{ title: 'Nothing owed', description: 'The query succeeded and no booking has an open posted payable.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="payables-aging">
            <ScrollRegion label="Age of posted supplier payables">
              <table style={tableStyle} aria-label="Age of posted supplier payables">
                <thead><tr>{['Supplier', 'Currency', ...PAYABLE_AGING_BUCKETS.map((b) => b.label), 'Total owed', 'Bookings'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.rows.map((r) => (
                  <tr key={`${r.supplierId}-${r.currency}`}>
                    <td style={td}>{r.name ?? 'Unnamed supplier'}</td><td style={td}>{r.currency}</td>
                    {r.buckets.map((b) => <td key={b.bucket} style={{ ...td, textAlign: 'right' }}><Money minor={b.amountMinor} currency={r.currency} />{b.bookings > 0 && <span style={{ fontSize: 10, color: 'var(--c-444444)' }}> · {b.bookings}</span>}</td>)}
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.totalMinor} currency={r.currency} /></td>
                    <td style={td}>{r.bookings}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            {d.truncated && <p style={{ fontSize: 11, padding: '4px 14px' }}>Showing the first {d.listLimit} supplier and currency rows.</p>}
          </div>
        )}
      </OpsState>

      <h2 style={{ fontSize: 14, margin: '18px 0 4px' }}>Due and overdue (against supplier payment terms)</h2>
      <p style={{ fontSize: 12, margin: '0 0 8px', color: 'var(--c-444444)' }}>
        Each booking's open balance against the supplier's agreed payment terms, set under Supplier settlements. The due date is the check-out, check-in or confirmation date plus the agreed days.
        A supplier with no terms, or a booking with no date for the basis, has no due date and is never shown as overdue. Approved payments clear the earliest-due bookings first.
      </p>
      <OpsState state={due.state} onRetry={due.reload} isEmpty={(d) => d.rows.length === 0} empty={{ title: 'Nothing owed', description: 'The query succeeded and no booking has an open posted payable.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="payables-due">
            <ScrollRegion label="Due and overdue supplier payables">
              <table style={tableStyle} aria-label="Due and overdue supplier payables">
                <thead><tr>{['Supplier', 'Currency', 'Terms', ...PAYABLE_DUE_BUCKETS.map((b) => b.label), 'Overdue', 'Total owed'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.rows.map((r) => (
                  <tr key={`${r.supplierId}-${r.currency}`}>
                    <td style={td}>{r.name ?? 'Unnamed supplier'}</td><td style={td}>{r.currency}</td><td style={td}>{termsText(r.basis, r.days)}</td>
                    {r.buckets.map((b) => <td key={b.bucket} style={{ ...td, textAlign: 'right' }}><Money minor={b.amountMinor} currency={r.currency} />{b.bookings > 0 && <span style={{ fontSize: 10, color: 'var(--c-444444)' }}> · {b.bookings}</span>}</td>)}
                    <td style={{ ...td, textAlign: 'right' }}>{r.overdueMinor !== '0' ? <Tag tone="bad"><Money minor={r.overdueMinor} currency={r.currency} /></Tag> : <Money minor={r.overdueMinor} currency={r.currency} />}</td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.totalMinor} currency={r.currency} /></td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <p style={{ fontSize: 11, padding: '4px 14px', color: 'var(--c-444444)' }}>As of {d.asOf} (UTC).{d.truncated ? ` Showing the first ${d.listLimit} rows.` : ''}</p>
          </div>
        )}
      </OpsState>
    </div>
  )
}
