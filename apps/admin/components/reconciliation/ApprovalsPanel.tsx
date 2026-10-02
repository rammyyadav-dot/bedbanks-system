'use client'

import { useRef, useState } from 'react'
import type { ReconciliationApprovalView } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import {
  cancelReconciliationApproval, decideReconciliationApproval, executeReconciliationApproval, getReconciliationApprovals, requestReconciliationApproval,
} from '@/lib/data/operations'
import { describeApiError } from '@/lib/api/describe-error'

const tone = (s: ReconciliationApprovalView['status']) => (s === 'APPROVED' ? 'ok' : s === 'REJECTED' || s === 'CANCELLED' ? 'bad' : s === 'EXECUTED' ? 'ok' : 'warn') as 'ok' | 'bad' | 'warn'

/**
 * Maker-checker for a reconciliation run (ADR 0017). Every button only calls the API; which buttons show comes from the
 * API's own flags (canDecide, canCancel, canExecute), and the server enforces them regardless. Approval authorises one
 * run with the approved parameters; it does not change what a run does.
 */
export function ApprovalsPanel({ onExecuted }: { onExecuted: () => void }) {
  const { state, reload } = useOpsQuery(() => getReconciliationApprovals({ pageSize: 25 }), [])
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)

  async function act(key: string, work: () => Promise<string>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(key); setNotice(null)
    try { setNotice({ tone: 'ok', text: await work() }); reload() }
    catch (error) { setNotice({ tone: 'bad', text: describeApiError(error, 'complete this approval step') }) }
    finally { inFlight.current = false; setBusy(null) }
  }
  const decideReason = (verb: string) => (typeof window === 'undefined' ? '' : window.prompt(`Reason to ${verb} (required)`) ?? '').trim()

  return (
    <section className="workspace-panel" style={{ padding: '12px 18px', marginBottom: 12 }} aria-labelledby="recon-approvals" data-testid="recon-approvals">
      <h2 id="recon-approvals">Approvals</h2>
      <p style={{ color: '#3f565c', fontSize: 12 }}>A second person approves a run before it executes. The approver cannot be the requester, and each approval runs once with the parameters it was approved with.</p>
      <form onSubmit={(e) => { e.preventDefault(); void act('request', async () => { await requestReconciliationApproval({ requestId: crypto.randomUUID(), reason }); setReason(''); return 'Approval requested.' }) }} style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 11 }}>Reason for the run<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required style={{ minWidth: 280 }} /></label>
        <button type="submit" className="admin-btn" disabled={busy !== null || reason.trim() === ''}>{busy === 'request' ? 'Requesting…' : 'Request approval'}</button>
      </form>
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="recon-approval-notice" style={{ marginTop: 8 }}>{notice.text}</div>}
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No approvals yet', description: 'No reconciliation approval has been requested for this tenant.' }}>
        {(d) => (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 8 }}>
            <thead><tr>{['Requested', 'Reason', 'Status', 'Stalled holds then', 'Decision', 'Actions'].map((h) => <th key={h} scope="col" style={{ textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #e6eef0' }}>{h}</th>)}</tr></thead>
            <tbody>
              {d.items.map((a) => (
                <tr key={a.id} data-testid={`approval-${a.status.toLowerCase()}`} style={{ borderBottom: '1px solid #edf2f3' }}>
                  <td style={{ padding: '8px 10px' }}>{when(a.createdAt)}</td>
                  <td style={{ padding: '8px 10px' }}>{a.reason}</td>
                  <td style={{ padding: '8px 10px' }}><Tag tone={tone(a.status)}>{a.status}</Tag></td>
                  <td style={{ padding: '8px 10px' }}>{a.stalledHoldsAtRequest ?? 'unknown'}</td>
                  <td style={{ padding: '8px 10px' }}>{a.decisionReason ? `${a.decisionReason}${a.decidedAt ? ` · ${when(a.decidedAt)}` : ''}` : '—'}</td>
                  <td style={{ padding: '8px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {a.canDecide && <>
                      <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const r = decideReason('approve'); if (r) void act(`a-${a.id}`, async () => { await decideReconciliationApproval(a.id, 'approve', r); return 'Approved.' }) }}>Approve</button>
                      <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const r = decideReason('reject'); if (r) void act(`r-${a.id}`, async () => { await decideReconciliationApproval(a.id, 'reject', r); return 'Rejected.' }) }}>Reject</button>
                    </>}
                    {a.canCancel && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`c-${a.id}`, async () => { await cancelReconciliationApproval(a.id); return 'Request cancelled.' })}>Cancel request</button>}
                    {a.canExecute && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`e-${a.id}`, async () => { const { data } = await executeReconciliationApproval(a.id); onExecuted(); return `Ran once: examined ${data.result.examined} stalled hold(s).` })}>{busy === `e-${a.id}` ? 'Running…' : 'Run approved reconciliation'}</button>}
                    {!a.canDecide && !a.canCancel && !a.canExecute && '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </OpsState>
    </section>
  )
}
