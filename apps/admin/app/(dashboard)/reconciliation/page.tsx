'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { getOpsReconciliation, runOpsReconciliation } from '@/lib/data/operations'
import { describeApiError } from '@/lib/api/describe-error'
import { ApiResponseError } from '@/lib/api/errors'
import type { ReconcileResponse } from '@bedbanks/contracts'
import { ApprovalsPanel } from '@/components/reconciliation/ApprovalsPanel'

export default function ReconciliationPage() {
  const { state, reload } = useOpsQuery(getOpsReconciliation, [])
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const inFlight = useRef(false) // blocks a second submit even before React re-renders
  const [outcome, setOutcome] = useState<{ result?: ReconcileResponse; requestId: string | null; error?: string } | null>(null)

  async function run() {
    if (inFlight.current) return
    inFlight.current = true; setRunning(true); setOutcome(null)
    try {
      const { data, requestId } = await runOpsReconciliation({})
      setOutcome({ result: data, requestId })
      reload()
    } catch (error) {
      setOutcome({ error: describeApiError(error, 'run reconciliation'), requestId: error instanceof ApiResponseError ? error.requestId : null })
    } finally { inFlight.current = false; setRunning(false); setConfirming(false) }
  }

  return (
    <div className="admin-page">
      <PageHeader eyebrow="RECONCILIATION" title="Reconciliation queue" description="Stalled booking attempts and consistency findings. Reconciliation resolves evidence through the existing idempotent service; it never sets a status by hand."
        actions={<button type="button" className="admin-btn" onClick={() => setConfirming(true)} disabled={running || confirming}>Run reconciliation…</button>} />
      {confirming && (
        <div className="admin-error" role="alertdialog" aria-labelledby="recon-confirm-title" data-testid="recon-confirm">
          <strong id="recon-confirm-title">Confirm reconciliation run</strong>
          <span>This releases inventory and any wallet reservation held by attempts that stalled for 30+ minutes, and marks those bookings FAILED. Prebooks still inside their confirmation window are left alone. Every step is idempotent and audited.</span>
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button type="button" className="admin-btn" onClick={run} disabled={running}>{running ? 'Running…' : 'Confirm and run'}</button>
            <button type="button" className="admin-btn" onClick={() => setConfirming(false)} disabled={running}>Cancel</button>
          </span>
        </div>
      )}
      {outcome?.error && <div className="admin-error" role="alert"><strong>Reconciliation did not complete</strong><span>{outcome.error}</span>{outcome.requestId ? <span>Request id: <code>{outcome.requestId}</code></span> : null}</div>}
      {outcome?.result && (
        <div className="workspace-panel" role="status" data-testid="recon-result">
          <p>Examined {outcome.result.examined} stalled hold(s). Request id: <code>{outcome.requestId ?? 'not returned'}</code></p>
          <ul>{outcome.result.items.map(i => <li key={i.holdId}><code>{i.holdId}</code> → {i.outcome}</li>)}</ul>
        </div>
      )}
      <ApprovalsPanel onExecuted={reload} />
      <OpsState state={state} onRetry={reload} isEmpty={d => d.cases.length === 0} empty={{ title: 'Nothing to reconcile', description: 'The check succeeded: no stalled holds and no consistency flags were found.' }}>
        {data => (
          <div className="workspace-panel">
            <p style={{ padding: '8px 18px', color: '#3f565c' }}>{data.total} case(s) · generated {when(data.generatedAt)} · stale threshold {data.staleMinutes} min</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead><tr>{['Source', 'Finding', 'Booking', 'Hold', 'Detail', 'Observed'].map(h => <th key={h} scope="col" style={{ textAlign: 'left', padding: '10px 14px', borderBottom: '1px solid #e6eef0' }}>{h}</th>)}</tr></thead>
              <tbody>
                {data.cases.map((c, i) => (
                  <tr key={`${c.holdId ?? c.bookingId}-${c.kind}-${i}`} style={{ borderBottom: '1px solid #edf2f3' }}>
                    <td style={{ padding: '10px 14px' }}>{c.source === 'reconciliation_dry_run' ? 'Stalled hold' : 'Consistency'}</td>
                    <td style={{ padding: '10px 14px' }}><Tag tone="bad">{c.kind}</Tag></td>
                    <td style={{ padding: '10px 14px' }}>{c.bookingId ? <Link href={`/bookings/${c.bookingId}`}>{c.bookingReference ?? c.bookingId}</Link> : '—'}{c.bookingStatus ? ` · ${c.bookingStatus}` : ''}</td>
                    <td style={{ padding: '10px 14px' }}>{c.holdId ? <Link href={`/holds/${c.holdId}`}>{c.holdId}</Link> : '—'}{c.holdStatus ? ` · ${c.holdStatus}` : ''}</td>
                    <td style={{ padding: '10px 14px' }}>{c.detail}</td>
                    <td style={{ padding: '10px 14px' }}>{when(c.observedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </OpsState>
    </div>
  )
}
