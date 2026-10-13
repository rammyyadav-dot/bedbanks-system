'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getOpsLedgerIntegrity } from '@/lib/data/operations'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const VERDICT = { PASS: ['ok', 'Ledger is consistent'], WARN: ['warn', 'Needs attention'], FAIL: ['bad', 'Ledger has errors'] } as const

/**
 * Ledger integrity (ADR 0063). The daily finance control: does every account add up, and does every booking's hold, release, charge and
 * refund chain follow the rules. Read-only: it finds problems for a person to investigate and corrects nothing.
 */
export default function LedgerIntegrityPage() {
  const data = useOpsQuery(() => getOpsLedgerIntegrity(), [])
  return (
    <div>
      <PageHeader eyebrow="FINANCE" title="Ledger integrity" description="Daily control over the append-only ledger: account balances, each booking's hold, release, charge and refund chain, and totals per currency. It reports problems and changes nothing." />
      <OpsState state={data.state} onRetry={data.reload}>
        {(d) => (
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0 }} data-testid="integrity-verdict">
              <Tag tone={VERDICT[d.status][0]}>{d.status}</Tag> <strong>{VERDICT[d.status][1]}.</strong>{' '}
              <span style={note}>Checked {d.scanned.accounts} accounts, {d.scanned.bookings} bookings and {d.scanned.entries} entries at {when(d.generatedAt)}. {d.counts.errors} errors, {d.counts.warnings} warnings.</span>
            </p>
            {d.truncated && <p style={{ ...note, color: '#8a5a00' }} data-testid="integrity-truncated">This ledger is larger than one report examines. Only the first part was checked, so a clean result here is not a full clearance.</p>}

            <div className="workspace-panel">
              <h2 style={{ fontSize: 13, margin: '0 0 6px' }}>Control totals by currency</h2>
              <p style={note}>Each currency stands alone; nothing is converted or added across currencies.</p>
              {d.control.length === 0 ? <p style={note}>No accounts exist yet.</p> : (
                <ScrollRegion label="Control totals">
                  <table style={tableStyle}>
                    <thead><tr>{['Currency', 'Accounts', 'Balance', 'Credit lines', 'Available', 'Overdrawn'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                    <tbody>{d.control.map(c => (
                      <tr key={c.currency} data-testid={`integrity-control-${c.currency}`}>
                        <td style={td}><strong>{c.currency}</strong></td>
                        <td style={{ ...td, textAlign: 'right' }}>{c.accounts}</td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={c.balanceMinor} currency={c.currency} /></td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={c.creditLineMinor} currency={c.currency} /></td>
                        <td style={{ ...td, textAlign: 'right' }}><Money minor={c.availableMinor} currency={c.currency} /></td>
                        <td style={{ ...td, textAlign: 'right' }}>{c.overdrawnAccounts === 0 ? '0' : <Tag tone="bad">{String(c.overdrawnAccounts)}</Tag>}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </ScrollRegion>
              )}
            </div>

            <div className="workspace-panel">
              <h2 style={{ fontSize: 13, margin: '0 0 6px' }}>Findings</h2>
              {d.findings.length === 0 ? <p style={note} data-testid="integrity-clean">No findings.</p> : (
                <>
                  <p style={note}>{d.counts.byCode.map(c => `${c.code.replace(/_/g, ' ').toLowerCase()}: ${c.count}`).join(' · ')}. Showing up to {d.findings.length} of {d.counts.errors + d.counts.warnings}. Holds open longer than {d.staleAuthorizationHours} hours are warnings.</p>
                  <ScrollRegion label="Findings">
                    <table style={tableStyle}>
                      <thead><tr>{['Severity', 'Finding', 'Booking / account', 'Held', 'Released', 'Charged', 'Refunded'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                      <tbody>{d.findings.map((f, i) => (
                        <tr key={`${f.code}-${f.bookingId ?? f.accountId}-${i}`} data-testid={`integrity-finding-${f.code}`}>
                          <td style={td}><Tag tone={f.severity === 'ERROR' ? 'bad' : 'warn'}>{f.severity.toLowerCase()}</Tag></td>
                          <td style={td}><strong>{f.code.replace(/_/g, ' ').toLowerCase()}</strong><div style={note}>{f.message}</div></td>
                          <td style={td}><code>{f.bookingId ?? f.accountId}</code></td>
                          {(['heldMinor', 'releasedMinor', 'chargedMinor', 'refundedMinor'] as const).map(k => (
                            <td key={k} style={{ ...td, textAlign: 'right' }}>{f.amountsMinor[k] !== undefined && f.currency ? <Money minor={f.amountsMinor[k]} currency={f.currency} /> : '—'}</td>
                          ))}
                        </tr>
                      ))}</tbody>
                    </table>
                  </ScrollRegion>
                </>
              )}
            </div>
          </div>
        )}
      </OpsState>
    </div>
  )
}
