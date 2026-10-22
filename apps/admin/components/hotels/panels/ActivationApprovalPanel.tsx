'use client'

import { useState } from 'react'
import type { RatePlanReadiness, RatePlanReadinessCheck } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { approvalStage, approvalSummary, newRequestId, STAGE_TITLE } from '@/lib/activation-approval-ui'
import { describeRatePlanActionError, readinessFailuresFromError } from '@/lib/rate-plan-errors'
import {
  approveRatePlanActivation, cancelRatePlanActivation, executeRatePlanActivation, getActivationApproval, getRatePlanReadiness,
  rejectRatePlanActivation, requestRatePlanActivation, type AdminRatePlan,
} from '@/lib/data'
import { Chip } from '../ui'

/**
 * Four-eye activation for one rate plan (ADR 0057, S5): request, a different manager decides, then apply. The API enforces every rule
 * (who may decide, version and content binding, readiness at apply); this panel shows the server's flags for the signed-in user.
 */
export function ActivationApprovalPanel({ plan, onClose, onDone }: { plan: AdminRatePlan; onClose: () => void; onDone: () => void }) {
  const approval = useOpsQuery(() => getActivationApproval(plan.id), [plan.id])
  const readiness = useOpsQuery<RatePlanReadiness>(() => getRatePlanReadiness(plan.id), [plan.id])
  const [reason, setReason] = useState('')
  const [requestId, setRequestId] = useState(() => newRequestId())
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [failedChecks, setFailedChecks] = useState<RatePlanReadinessCheck[]>([])

  const act = async (work: () => Promise<unknown>, refresh = true) => {
    setBusy(true); setError(null); setFailedChecks([])
    try { await work(); setReason(''); setRequestId(newRequestId()); if (refresh) { approval.reload(); readiness.reload() } } catch (e) {
      setError(describeRatePlanActionError(e, 'activate')); setFailedChecks(readinessFailuresFromError(e)); approval.reload(); readiness.reload()
    } finally { setBusy(false) }
  }

  return (
    <section aria-label={`activation approval ${plan.code}`} style={{ border: '1px solid var(--c-e5e7eb)', background: 'var(--c-f7f8fa)', padding: 12, display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13 }}>Activate <code>{plan.code}</code> · needs a second person</h3>
      <OpsState state={approval.state} onRetry={approval.reload}>
        {(current) => {
          const stage = approvalStage(current)
          return (
            <>
              <p data-testid="approval-stage" data-stage={stage} style={{ margin: 0, fontSize: 12 }}><strong>{STAGE_TITLE[stage]}</strong>{current && stage !== 'request' ? <> · {approvalSummary(current)}</> : null}</p>
              {current && stage !== 'request' ? <p style={{ margin: 0, fontSize: 12 }}>Requester's reason: {current.reason}</p> : null}
              {stage === 'request' ? (
                <OpsState state={readiness.state} onRetry={readiness.reload}>
                  {(r) => (
                    <>
                      <ul data-testid="readiness-checklist" style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
                        {r.checks.map((c) => <li key={c.code} data-check={c.code} data-ok={c.ok} style={{ padding: '2px 0' }}><Chip tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'PASS' : 'FAIL'}</Chip> <strong>{c.label}</strong>: {c.message}</li>)}
                      </ul>
                      <label style={{ fontSize: 11 }}>Why this plan should go live (shown to the approver) <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Request reason" maxLength={500} style={{ width: '100%' }} /></label>
                      <p style={{ margin: 0, fontSize: 11, color: 'var(--c-3f565c)' }}>The approver reviews exactly these terms and rates. Changing a price, a term or loading another night afterwards voids the approval.</p>
                      <button type="button" className="admin-btn admin-btn-primary" disabled={busy || !r.ready || reason.trim().length < 3} onClick={() => act(() => requestRatePlanActivation(plan.id, { requestId, reason: reason.trim(), expectedUpdatedAt: r.updatedAt }))}>{busy ? 'Sending…' : 'Request activation'}</button>
                    </>
                  )}
                </OpsState>
              ) : null}
              {current && stage === 'awaiting-other' ? (
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontSize: 12 }}>A different user with rate management permission must approve it.</span>
                  {current.canCancel ? <button type="button" className="admin-btn" disabled={busy} onClick={() => act(() => cancelRatePlanActivation(current.id))}>Withdraw request</button> : null}
                </span>
              ) : null}
              {current && stage === 'decide' ? (
                <>
                  <label style={{ fontSize: 11 }}>Decision note (recorded in the audit history) <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Decision reason" maxLength={500} style={{ width: '100%' }} /></label>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="admin-btn admin-btn-primary" disabled={busy || reason.trim().length < 3} onClick={() => act(() => approveRatePlanActivation(current.id, reason.trim()))}>Approve</button>
                    <button type="button" className="admin-btn" disabled={busy || reason.trim().length < 3} onClick={() => act(() => rejectRatePlanActivation(current.id, reason.trim()))}>Reject</button>
                  </span>
                </>
              ) : null}
              {current && stage === 'execute' ? (
                <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={() => act(async () => { await executeRatePlanActivation(current.id); onDone() }, false)}>{busy ? 'Activating…' : 'Activate now'}</button>
              ) : null}
            </>
          )
        }}
      </OpsState>
      {error ? <p role="alert" style={{ color: 'var(--c-a11d1d)', fontSize: 12, margin: 0 }}>{error}</p> : null}
      {failedChecks.length ? (
        <ul data-testid="server-failed-checks" aria-label="Checks the server rejected" style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
          {failedChecks.map((c) => <li key={c.code} data-check={c.code}><Chip tone="bad">FAIL</Chip> <strong>{c.label}</strong>: {c.message}</li>)}
        </ul>
      ) : null}
      <span style={{ display: 'flex', gap: 8 }}><button type="button" className="admin-btn" onClick={onClose}>Close</button></span>
    </section>
  )
}
