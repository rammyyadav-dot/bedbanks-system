'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getOpsReceivables } from '@/lib/data/operations'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const

/**
 * Receivables (ADR 0028 slice 4). Agency accounts with unpaid charges, oldest first. Payments settle the oldest charge first; a refund
 * first settles its own booking. Read-only: an agency pays by bank transfer, recorded under Funding receipts.
 */
export default function ReceivablesPage() {
  const data = useOpsQuery(() => getOpsReceivables(), [])
  return (
    <div>
      <PageHeader eyebrow="FINANCE" title="Receivables" description="Agencies with unpaid booking charges. From the notice threshold the agency is flagged; from the refusal threshold it cannot place new holds or bookings until a payment is posted." />
      <OpsState state={data.state} onRetry={data.reload}>
        {(d) => (
          <div style={{ display: 'grid', gap: 10 }}>
            <p style={note} data-testid="receivables-terms">Payment terms: notice after {d.noticeDays} days, new holds refused after {d.refuseHoldsAfterDays} days. {d.counts.notice} on notice, {d.counts.holdsRefused} refused.</p>
            {d.items.length === 0 ? <p style={note}>No agency has unpaid charges.</p> : (
              <div className="workspace-panel">
                <ScrollRegion label="Receivables">
                  <table style={tableStyle}>
                    <thead><tr>{['Agency', 'Unpaid', 'Balance', 'Oldest unpaid', 'Days', 'State'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                    <tbody>{d.items.map(r => (
                      <tr key={r.accountId} data-testid={`receivable-${r.overdue.state.toLowerCase()}`}>
                        <td style={td}><strong>{r.agency.name}</strong> <code>{r.agency.code}</code>{r.agency.status !== 'ACTIVE' && <div><Tag>{r.agency.status.toLowerCase()}</Tag></div>}</td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={r.overdue.unpaidMinor} currency={r.currency} /></td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={r.balanceMinor} currency={r.currency} /></td>
                        <td style={td}>{r.overdue.oldestUnpaidAt ? when(r.overdue.oldestUnpaidAt) : '—'}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{r.overdue.daysOverdue}</td>
                        <td style={td}>{r.overdue.state === 'HOLDS_REFUSED' ? <Tag tone="bad">holds refused</Tag> : r.overdue.state === 'NOTICE' ? <Tag tone="warn">notice</Tag> : <Tag>current</Tag>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </ScrollRegion>
              </div>
            )}
          </div>
        )}
      </OpsState>
    </div>
  )
}
