'use client'

import { useState } from 'react'
import type { ContractLifecycleView } from '@bedbanks/contracts'
import { Chip } from '@/components/hotels/ui'
import { describeApiError } from '@/lib/api/describe-error'
import { CONTRACT_STAGE_TITLE, contractStage, describeChanges, newContractRequestId } from '@/lib/contract-lifecycle-ui'
import { cancelContractApproval, decideContractApproval, executeContractApproval, requestContractActivation, transitionContract } from '@/lib/data'

/**
 * Contract lifecycle (ADR 0067): status, activation readiness, the open maker-checker request and the version history.
 * The API enforces every rule (who may decide, the term binding, readiness at apply); this panel shows the server's flags for the signed-in user.
 */
export function ContractLifecyclePanel({ view, canManage, onChanged }: { view: ContractLifecycleView; canManage: boolean; onChanged: () => void }) {
  const [reason, setReason] = useState('')
  const [requestId, setRequestId] = useState(() => newContractRequestId())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = view.openRequest
  const stage = contractStage(open)

  const act = async (work: () => Promise<unknown>, action: string) => {
    setBusy(true); setError(null)
    try { await work(); setReason(''); setRequestId(newContractRequestId()) } catch (e) { setError(describeApiError(e, action)) } finally { setBusy(false); onChanged() }
  }
  const transition = (action: 'submit' | 'returnToDraft' | 'suspend') => act(() => transitionContract(view.contractId, action, { expectedUpdatedAt: view.updatedAt, ...(action === 'suspend' ? { reason: reason.trim() } : {}) }), action === 'suspend' ? 'suspend the contract' : 'change the contract status')
  const canRequestActivation = view.readiness.ready && !open && ['DRAFT', 'REVIEW', 'SUSPENDED'].includes(view.status)

  return (
    <section className="workspace-panel" style={{ maxWidth: 760, padding: 22, marginTop: 16, display: 'grid', gap: 10 }} aria-label="Contract lifecycle" data-testid="contract-lifecycle">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>Status and approval</h2>
        <Chip tone={view.status === 'ACTIVE' ? 'ok' : view.status === 'SUSPENDED' || view.status === 'EXPIRED' ? 'bad' : 'neutral'}>{view.status}</Chip>
        <span style={{ fontSize: 12 }}>Version {view.version}</span>
        {!view.termsEditable ? <span style={{ fontSize: 12, color: '#3f565c' }}>{view.status === 'ACTIVE' ? 'Terms are locked. Changes go through an amendment a second person approves.' : 'An expired contract cannot be changed.'}</span> : null}
      </div>

      {['DRAFT', 'REVIEW', 'SUSPENDED'].includes(view.status) ? (
        <ul data-testid="contract-readiness" style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
          {view.readiness.checks.map((c) => <li key={c.code} data-check={c.code} data-ok={c.ok} style={{ padding: '2px 0' }}><Chip tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'PASS' : 'FAIL'}</Chip> <strong>{c.label}</strong>: {c.message}</li>)}
        </ul>
      ) : null}

      <p data-testid="contract-stage" data-stage={stage} style={{ margin: 0, fontSize: 12 }}>
        <strong>{CONTRACT_STAGE_TITLE[stage]}</strong>
        {open ? <> · {open.kind === 'AMEND' ? 'Amendment' : 'Activation'} requested {open.createdAt.slice(0, 10)} · reason: {open.reason}</> : null}
      </p>
      {open?.kind === 'AMEND' ? <ul style={{ margin: 0, fontSize: 12 }}>{describeChanges(open.changes).map((line) => <li key={line}>{line}</li>)}</ul> : null}
      {open?.changedSinceRequest ? <p role="status" style={{ margin: 0, fontSize: 12, color: '#8a5a00' }}>The terms changed after this request was filed, so it can no longer be approved or applied. Withdraw it and file a new one.</p> : null}

      {canManage ? (
        <>
          <label style={{ fontSize: 11 }}>{stage === 'decide' ? 'Decision note (recorded in the audit history)' : view.status === 'ACTIVE' ? 'Reason to suspend (required)' : 'Reason shown to the approver'}
            <input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Lifecycle reason" maxLength={500} style={{ width: '100%' }} />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {view.status === 'DRAFT' ? <button type="button" className="admin-btn" disabled={busy} onClick={() => transition('submit')}>Submit for review</button> : null}
            {view.status === 'REVIEW' ? <button type="button" className="admin-btn" disabled={busy} onClick={() => transition('returnToDraft')}>Return to draft</button> : null}
            {stage === 'none' && ['DRAFT', 'REVIEW', 'SUSPENDED'].includes(view.status) ? (
              <button type="button" className="admin-btn admin-btn-primary" disabled={busy || !canRequestActivation || reason.trim().length < 3}
                onClick={() => act(() => requestContractActivation(view.contractId, { requestId, reason: reason.trim(), expectedFingerprint: view.fingerprint }), 'request activation')}>Request activation</button>
            ) : null}
            {view.status === 'ACTIVE' && stage === 'none' ? <button type="button" className="admin-btn" disabled={busy || reason.trim().length < 3} onClick={() => transition('suspend')}>Suspend contract</button> : null}
            {stage === 'awaiting-other' && open?.canCancel ? <button type="button" className="admin-btn" disabled={busy} onClick={() => act(() => cancelContractApproval(open.id), 'withdraw the request')}>Withdraw request</button> : null}
            {stage === 'decide' && open ? (
              <>
                <button type="button" className="admin-btn admin-btn-primary" disabled={busy || reason.trim().length < 3 || open.changedSinceRequest} onClick={() => act(() => decideContractApproval(open.id, 'approve', reason.trim()), 'approve the request')}>Approve</button>
                <button type="button" className="admin-btn" disabled={busy || reason.trim().length < 3} onClick={() => act(() => decideContractApproval(open.id, 'reject', reason.trim()), 'reject the request')}>Reject</button>
              </>
            ) : null}
            {stage === 'execute' && open ? <button type="button" className="admin-btn admin-btn-primary" disabled={busy || open.changedSinceRequest} onClick={() => act(() => executeContractApproval(open.id), 'apply the approved request')}>{open.kind === 'AMEND' ? 'Apply amendment' : 'Activate now'}</button> : null}
          </div>
          {stage === 'awaiting-other' ? <p style={{ margin: 0, fontSize: 11, color: '#3f565c' }}>A different user with contract management permission must approve it. Editing any term before it is applied voids the approval.</p> : null}
        </>
      ) : <p role="status" style={{ fontSize: 12, margin: 0 }}>You have read-only access to contracts.</p>}
      {error ? <p role="alert" style={{ color: '#a11d1d', fontSize: 12, margin: 0 }}>{error}</p> : null}

      <details>
        <summary style={{ fontSize: 12, cursor: 'pointer' }}>Version history ({view.versions.length})</summary>
        {view.versions.length === 0 ? <p style={{ fontSize: 12 }}>No approved version yet.</p> : (
          <ol style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 18 }} data-testid="contract-versions">
            {view.versions.map((v) => <li key={v.version} value={v.version}><strong>v{v.version}</strong> · {v.kind === 'AMENDMENT' ? 'amendment' : 'activation'} · {v.createdAt.slice(0, 10)} · valid {v.terms.validFrom} to {v.terms.validTo} · {v.terms.cancellationPolicies.length} cancellation rule(s) · reason: {v.reason}</li>)}
          </ol>
        )}
      </details>
    </section>
  )
}
