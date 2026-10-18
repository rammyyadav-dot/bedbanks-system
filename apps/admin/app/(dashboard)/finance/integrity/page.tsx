'use client'

import { useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { IntegrityReport, note } from '@/components/finance/IntegrityReport'
import { getOpsLedgerIntegrity, getOpsLedgerIntegrityRun, getOpsLedgerIntegrityRuns } from '@/lib/data/operations'
import { scheduleBanner } from '@/lib/ledger-integrity-schedule-ui'

const VERDICT = { PASS: ['ok', 'Ledger is consistent'], WARN: ['warn', 'Needs attention'], FAIL: ['bad', 'Ledger has errors'] } as const
const TONE = { PASS: 'ok', WARN: 'warn', FAIL: 'bad' } as const

/**
 * Ledger integrity (ADR 0063, ADR 0064). The daily finance control: does every account add up, and does every booking's hold, release, charge and
 * refund chain follow the rules. The nightly record keeps one unchangeable result per night; the live check runs the same rules now.
 * Read-only: it finds problems for a person to investigate and corrects nothing.
 */
export default function LedgerIntegrityPage() {
  const [openRun, setOpenRun] = useState<string | null>(null)
  const history = useOpsQuery(() => getOpsLedgerIntegrityRuns(), [])
  const stored = useOpsQuery(() => (openRun ? getOpsLedgerIntegrityRun(openRun) : Promise.resolve(null)), [openRun])
  const live = useOpsQuery(() => getOpsLedgerIntegrity(), [])
  return (
    <div>
      <PageHeader eyebrow="FINANCE" title="Ledger integrity" description="Daily control over the append-only ledger: account balances, each booking's hold, release, charge and refund chain, and totals per currency. It reports problems and changes nothing." />
      <div style={{ display: 'grid', gap: 16 }}>
        <section aria-labelledby="nightly-h" style={{ display: 'grid', gap: 8 }}>
          <h2 id="nightly-h" style={{ fontSize: 14, margin: 0 }}>Nightly record</h2>
          <OpsState state={history.state} onRetry={history.reload}>
            {(h) => {
              const banner = scheduleBanner(h)
              return (
                <div style={{ display: 'grid', gap: 8 }}>
                  <p style={{ margin: 0 }} data-testid="nightly-banner" data-tone={banner.tone}><Tag tone={banner.tone}>{banner.label}</Tag> <span style={note}>{banner.detail}</span></p>
                  {h.runs.length > 0 && (
                    <div className="workspace-panel">
                      <ScrollRegion label="Nightly runs">
                        <table style={tableStyle}>
                          <thead><tr>{['Night (UTC)', 'Result', 'Errors', 'Warnings', 'Accounts', 'Bookings', 'Taken', ''].map(c => <th key={c} scope="col" style={th}>{c}</th>)}</tr></thead>
                          <tbody>{h.runs.map(r => (
                            <tr key={r.id} data-testid={`nightly-run-${r.runDate}`} data-status={r.status}>
                              <td style={td}><strong>{r.runDate}</strong></td>
                              <td style={td}><Tag tone={TONE[r.status]}>{r.status}</Tag>{r.truncated && <> <Tag tone="warn">partial</Tag></>}</td>
                              <td style={{ ...td, textAlign: 'right' }}>{r.errors}</td>
                              <td style={{ ...td, textAlign: 'right' }}>{r.warnings}</td>
                              <td style={{ ...td, textAlign: 'right' }}>{r.accountsScanned}</td>
                              <td style={{ ...td, textAlign: 'right' }}>{r.bookingsScanned}</td>
                              <td style={td}>{when(r.createdAt)}</td>
                              <td style={td}><button type="button" className="admin-btn" aria-pressed={openRun === r.id} onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>{openRun === r.id ? 'Hide' : 'View'}</button></td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </ScrollRegion>
                    </div>
                  )}
                </div>
              )
            }}
          </OpsState>
          {openRun && (
            <OpsState state={stored.state} onRetry={stored.reload}>
              {(s) => s && (
                <div style={{ display: 'grid', gap: 8 }} data-testid="stored-run">
                  <p style={{ margin: 0 }}><Tag tone={TONE[s.run.status]}>{s.run.status}</Tag> <strong>Night of {s.run.runDate}.</strong> <span style={note}>Exactly as it was recorded at {when(s.report.generatedAt)}; it cannot be edited.</span></p>
                  <IntegrityReport d={s.report} />
                </div>
              )}
            </OpsState>
          )}
        </section>

        <section aria-labelledby="live-h" style={{ display: 'grid', gap: 8 }}>
          <h2 id="live-h" style={{ fontSize: 14, margin: 0 }}>Live check</h2>
          <OpsState state={live.state} onRetry={live.reload}>
            {(d) => (
              <div style={{ display: 'grid', gap: 12 }}>
                <p style={{ margin: 0 }} data-testid="integrity-verdict">
                  <Tag tone={VERDICT[d.status][0]}>{d.status}</Tag> <strong>{VERDICT[d.status][1]}.</strong>{' '}
                  <span style={note}>Checked {d.scanned.accounts} accounts, {d.scanned.bookings} bookings and {d.scanned.entries} entries at {when(d.generatedAt)}. {d.counts.errors} errors, {d.counts.warnings} warnings.</span>
                </p>
                <IntegrityReport d={d} />
              </div>
            )}
          </OpsState>
        </section>
      </div>
    </div>
  )
}
