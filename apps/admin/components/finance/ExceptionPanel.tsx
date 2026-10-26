'use client'

import { useState } from 'react'
import type { ReconExceptionDetail, ReconResolutionAction } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { approveReconDecision, getReconException, proposeReconDecision, rejectReconDecision } from '@/lib/data/finance-reconciliation'
import { describeApiError } from '@/lib/api/describe-error'
import { useStepUp } from '@/components/common/StepUpDialog'
import { ACTION_LABEL, STATUS_LABEL, TYPE_LABEL, severityTone, statusTone } from '@/lib/reconciliation-ui'

const lab = { display: 'grid', gap: 4, fontSize: 11, color: 'var(--c-3f565c)' } as const
const dt = { color: 'var(--c-6d858c)', fontSize: 11 } as const

/**
 * One exception of the dispute queue. It shows what the server says about the exception and offers only the decisions the server lists.
 * Recording a decision posts nothing to the ledger; the second-person rule is enforced by the API and the database, and shown here only as guidance.
 */
export function ExceptionPanel({ id, canResolve, onClose, onChanged }: { id: string; canResolve: boolean; onClose: () => void; onChanged: (message: string) => void }) {
  const [version, setVersion] = useState(0)
  const q = useOpsQuery(() => getReconException(id), [id, version])
  return (
    <section className="workspace-panel" aria-label="Exception detail" data-testid="recon-panel" style={{ padding: '14px 18px', marginTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>Review exception</h2>
        <button type="button" className="admin-btn" onClick={onClose}>Close</button>
      </div>
      <OpsState state={q.state} onRetry={q.reload}>
        {(d) => <Body d={d} canResolve={canResolve} onDone={(message) => { setVersion((v) => v + 1); onChanged(message) }} />}
      </OpsState>
    </section>
  )
}

function Body({ d, canResolve, onDone }: { d: ReconExceptionDetail; canResolve: boolean; onDone: (message: string) => void }) {
  const e = d.exception
  const [action, setAction] = useState<ReconResolutionAction | ''>('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonOk = reason.trim().length >= 3
  const { confirm, dialog } = useStepUp()
  const chosen = action || e.allowedActions[0]

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null)
    try { await work(); setReason(''); setAction(''); onDone(done) } catch (err) { setError(describeApiError(err, 'record the decision')) } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
      {dialog}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tag tone={severityTone(e.severity)}>{e.severity.toLowerCase()}</Tag>
        <strong style={{ fontSize: 13 }}>{TYPE_LABEL[e.type]}</strong>
        <Tag tone={statusTone(e.status)}>{STATUS_LABEL[e.status]}</Tag>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--c-3f565c)' }}>{e.hint}</p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px 18px', margin: 0 }}>
        <div><dt style={dt}>Supplier</dt><dd style={{ margin: 0 }}>{e.supplier.displayName}</dd></div>
        <div><dt style={dt}>Statement</dt><dd style={{ margin: 0 }}><code>{e.statementRef}</code>{e.lineNo !== null && ` · line ${e.lineNo}`}</dd></div>
        <div><dt style={dt}>Reference on statement</dt><dd style={{ margin: 0 }}>{e.reference ? <code>{e.reference}</code> : '—'}</dd></div>
        <div><dt style={dt}>Our booking</dt><dd style={{ margin: 0 }}>{e.booking ? <code>{e.booking.reference}</code> : '—'}</dd></div>
        <div><dt style={dt}>Statement amount</dt><dd style={{ margin: 0 }}><Money minor={e.statementMinor} currency={e.currency} /></dd></div>
        <div><dt style={dt}>Ledger net</dt><dd style={{ margin: 0 }}><Money minor={e.ledgerMinor} currency={e.currency} /></dd></div>
        <div><dt style={dt}>Variance (statement − ledger)</dt><dd style={{ margin: 0 }}>{e.varianceMinor === null ? <span title="Not computed: currencies differ or an amount is unknown">not computed</span> : <Money minor={e.varianceMinor} currency={e.currency} />}</dd></div>
      </dl>

      {e.status === 'PENDING_APPROVAL' && (
        <div role="group" aria-label="Pending decision" style={{ border: '1px solid var(--c-ecd9a8)', background: 'var(--c-fffaf0)', borderRadius: 6, padding: 10 }}>
          <p style={{ margin: 0, fontSize: 12 }}>Proposed: <strong>{e.proposedAction ? ACTION_LABEL[e.proposedAction] : ''}</strong>. A second person must confirm it.</p>
          {canResolve && e.canDecide ? (
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <label style={lab}>Reason (required)<textarea className="input-wrap" style={{ height: 56, padding: 6 }} maxLength={500} value={reason} onChange={(ev) => setReason(ev.target.value)} data-testid="recon-approve-reason" /></label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="admin-btn" disabled={busy || !reasonOk} data-testid="recon-approve" onClick={() => confirm({ title: 'Approve reconciliation decision', description: `Approve "${e.proposedAction ? ACTION_LABEL[e.proposedAction] : 'the proposed decision'}" for this exception. The exception is resolved.`, run: async (password) => { await approveReconDecision(e.id, { reason }, password); setReason(''); setAction(''); onDone('Decision approved. The exception is resolved.') } })}>Approve</button>
                <button type="button" className="admin-btn" disabled={busy || !reasonOk} data-testid="recon-send-back" onClick={() => void run(() => rejectReconDecision(e.id, { reason }), 'Sent back to the queue.')}>Send back</button>
              </div>
            </div>
          ) : <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--c-6d5a1a)' }}>{e.proposedById ? 'You proposed this, or you cannot decide it. A different person with the resolve permission must approve.' : ''}</p>}
        </div>
      )}

      {canResolve && e.canPropose && e.allowedActions.length > 0 && (
        <form aria-label="Record a decision" style={{ display: 'grid', gap: 8 }} onSubmit={(ev) => { ev.preventDefault(); if (chosen && reasonOk) void run(() => proposeReconDecision(e.id, { action: chosen, reason }), d.secondApprovalRequired[chosen] ? 'Proposed. A different person must approve it.' : 'Decision recorded.') }}>
          <label style={lab}>Decision
            <select className="input-wrap" value={chosen} onChange={(ev) => setAction(ev.target.value as ReconResolutionAction)} data-testid="recon-action">
              {e.allowedActions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
            </select>
          </label>
          {chosen && <p style={{ margin: 0, fontSize: 11, color: 'var(--c-3f565c)' }}>{d.secondApprovalRequired[chosen] ? 'This amount needs a second person to approve before the exception closes.' : 'No second person is needed for this decision.'} Nothing is posted to the ledger.</p>}
          <label style={lab}>Reason (required, kept in the history)<textarea className="input-wrap" style={{ height: 56, padding: 6 }} maxLength={500} value={reason} onChange={(ev) => setReason(ev.target.value)} data-testid="recon-reason" /></label>
          <div><button type="submit" className="admin-btn" disabled={busy || !reasonOk} data-testid="recon-submit">{chosen && d.secondApprovalRequired[chosen] ? 'Propose decision' : 'Record decision'}</button></div>
        </form>
      )}
      {error && <p role="alert" style={{ margin: 0, color: 'var(--c-a11d1d)', fontSize: 12 }}>{error}</p>}

      <div>
        <h3 style={{ fontSize: 12, margin: '0 0 6px' }}>History</h3>
        {d.history.length === 0 ? <p style={{ margin: 0, fontSize: 11, color: 'var(--c-6d858c)' }}>No decisions yet.</p> : (
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 11, display: 'grid', gap: 4 }}>
            {d.history.map((h) => <li key={h.id}>{when(h.createdAt)} · <strong>{h.action.replace(/_/g, ' ').toLowerCase()}</strong> · {STATUS_LABEL[h.fromStatus]} → {STATUS_LABEL[h.toStatus]}{h.actorId ? '' : ' (automatic)'}{h.reason && <span style={{ color: 'var(--c-52696f)' }}> — {h.reason}</span>}</li>)}
          </ol>
        )}
      </div>
    </div>
  )
}
