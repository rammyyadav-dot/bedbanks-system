'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getSupplierPayables } from '@/lib/data/operations'

/**
 * Supplier payables, slice 1 (ADR 0054). A read-only accrual of recorded supplier net cost for confirmed stays. It is NOT an amount owed:
 * no supplier invoice, payment or settlement exists in the system, and nothing on this page posts or changes anything.
 */
export default function SupplierPayablesPage() {
  const q = useOpsQuery(() => getSupplierPayables(), [])
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
            <details style={{ fontSize: 11, color: '#3f565c', padding: '6px 14px' }}><summary>What these numbers mean</summary><ul>{Object.entries(d.definitions).map(([k, v]) => <li key={k}><strong>{k}</strong>: {v}</li>)}</ul></details>
          </div>
        )}
      </OpsState>
    </div>
  )
}
