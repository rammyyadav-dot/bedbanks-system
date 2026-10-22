'use client'

import { useEffect, useState } from 'react'
import { ReconciliationScopeNote } from './ReconciliationScopeNote'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getReconStatement, getReconStatements, requestReconRun } from '@/lib/data/finance-reconciliation'
import { describeApiError } from '@/lib/api/describe-error'
import { RUN_ERROR_TEXT, RUN_LABEL, runIsActive, runTone } from '@/lib/reconciliation-ui'
import { StatementImport } from './StatementImport'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-3f565c)' } as const

/** Imported statements, their latest matching run and settlement figures. Running the match is the only action and posts nothing. */
export function ReconciliationStatements({ canRun, onMessage, onOpenQueue }: { canRun: boolean; onMessage: (m: string) => void; onOpenQueue: (statementId: string) => void }) {
  const [page, setPage] = useState(1)
  const [openId, setOpenId] = useState<string | null>(null)
  const [tolerance, setTolerance] = useState('0')
  const [busy, setBusy] = useState(false)
  const q = useOpsQuery(() => getReconStatements({ page, pageSize: 10 }), [page])
  const anyActive = q.state.status === 'ready' && q.state.data.items.some((s) => runIsActive(s.latestRun?.status))
  useEffect(() => {
    if (!anyActive) return
    const t = setInterval(() => q.refresh(), 3000)
    return () => clearInterval(t)
  }, [anyActive, q])

  async function run(statementId: string) {
    setBusy(true)
    try { await requestReconRun(statementId, { requestId: crypto.randomUUID(), roundingToleranceMinor: tolerance.trim() || '0' }); onMessage('Matching queued. The worker picks it up within seconds; this table refreshes by itself.'); q.refresh() } catch (error) { onMessage(describeApiError(error, 'queue the run')) } finally { setBusy(false) }
  }

  return (
    <div>
      {canRun && <StatementImport onImported={(m) => { onMessage(m); q.reload() }} />}
      {canRun && (
        <label style={{ ...lab, marginBottom: 10, maxWidth: 360 }}>Rounding tolerance for the next run (minor units; 0 matches amounts exactly)
          <input className="input-wrap" inputMode="numeric" maxLength={4} value={tolerance} onChange={(e) => setTolerance(e.target.value.replace(/\D/g, ''))} data-testid="recon-tolerance" />
        </label>
      )}
      <OpsState state={q.state} onRetry={q.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No statements imported', description: 'Import a supplier settlement statement to compare it with the ledger.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="recon-statements">
            <ScrollRegion label="Supplier statements">
              <table style={tableStyle} aria-label="Supplier statements">
                <thead><tr>{['Supplier', 'Statement', 'Period', 'Lines', 'Matching', 'Exceptions', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((s) => (
                  <tr key={s.id}>
                    <td style={td}>{s.supplier.displayName}</td>
                    <td style={td}><code>{s.statementRef}</code><div style={{ fontSize: 10 }}>imported {when(s.importedAt)}</div></td>
                    <td style={td}>{s.periodStart} → {s.periodEnd}</td>
                    <td style={td}>{s.lineCount}</td>
                    <td style={td}>
                      {s.latestRun ? <><Tag tone={runTone(s.latestRun.status)}>{RUN_LABEL[s.latestRun.status]}</Tag>{s.latestRun.errorCode && <div style={{ fontSize: 10 }}>{RUN_ERROR_TEXT[s.latestRun.errorCode] ?? 'The run failed.'}</div>}{s.latestRun.finishedAt && <div style={{ fontSize: 10 }}>{when(s.latestRun.finishedAt)}</div>}</> : <span style={{ fontSize: 11 }}>Not run yet</span>}
                    </td>
                    <td style={td}>
                      <div style={{ fontSize: 11 }}>{s.exceptions.open} open · {s.exceptions.disputed} disputed · {s.exceptions.pendingApproval} awaiting</div>
                      <div style={{ fontSize: 10, color: 'var(--c-6d858c)' }}>{s.exceptions.resolved} resolved</div>
                    </td>
                    <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {canRun && <button type="button" className="admin-btn" disabled={busy || runIsActive(s.latestRun?.status)} data-testid="recon-run" onClick={() => void run(s.id)}>{s.latestRun ? 'Re-run matching' : 'Run matching'}</button>}
                      <button type="button" className="admin-btn" onClick={() => onOpenQueue(s.id)}>View exceptions</button>
                      <button type="button" className="admin-btn" aria-expanded={openId === s.id} onClick={() => setOpenId(openId === s.id ? null : s.id)}>Settlement</button>
                    </td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
            {openId && <Settlement id={openId} />}
          </div>
        )}
      </OpsState>
      <ReconciliationScopeNote />
    </div>
  )
}

function Settlement({ id }: { id: string }) {
  const q = useOpsQuery(() => getReconStatement(id), [id])
  return (
    <div style={{ padding: '10px 18px', borderTop: '1px solid var(--c-e5eef0)' }}>
      <OpsState state={q.state} onRetry={q.reload}>
        {(d) => (
          <div>
            <table style={tableStyle} aria-label="Settlement by currency">
              <thead><tr>{['Currency', 'Charges', 'Credits', 'Statement net', 'Matched', 'Exceptions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{d.settlement.map((r) => (
                <tr key={r.currency}>
                  <td style={td}>{r.currency}</td>
                  <td style={{ ...td, textAlign: 'right' }}><Money minor={r.chargesMinor} currency={r.currency} /></td>
                  <td style={{ ...td, textAlign: 'right' }}><Money minor={r.creditsMinor} currency={r.currency} /></td>
                  <td style={{ ...td, textAlign: 'right' }}><strong><Money minor={r.statementNetMinor} currency={r.currency} /></strong></td>
                  <td style={{ ...td, textAlign: 'right' }}><Money minor={r.matchedMinor} currency={r.currency} /></td>
                  <td style={{ ...td, textAlign: 'right' }}><Money minor={r.exceptionMinor} currency={r.currency} /></td>
                </tr>))}</tbody>
            </table>
            <details style={{ fontSize: 11, color: 'var(--c-3f565c)', marginTop: 6 }}><summary>What these numbers mean</summary><ul>{Object.entries(d.definitions).map(([k, v]) => <li key={k}><strong>{k}</strong>: {v}</li>)}</ul></details>
          </div>
        )}
      </OpsState>
    </div>
  )
}
