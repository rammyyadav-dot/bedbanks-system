'use client'

import { useCallback, useState, type FormEvent, type ReactNode } from 'react'
import { Modal } from '@/components/bookings/Modal'
import { ErrorState } from '@/components/common/ErrorState'
import { ApiResponseError } from '@/lib/api/errors'
import { describeApiError } from '@/lib/api/describe-error'

export interface StepUpRequest {
  /** What the checker is about to authorise, for example "Approve markup activation". */
  title: string
  /** One sentence naming exactly what will change. */
  description: string
  /** Runs the decision with the password the checker typed. Throw to keep the dialog open and show the failure. */
  run: (password: string) => Promise<void>
}

/** Failures that retrying the same password cannot fix: the dialog offers Close, not another try. */
const FINAL = new Set(['APPROVAL_EXPIRED', 'DUAL_APPROVAL_REQUIRED', 'STEP_UP_THROTTLED'])

/**
 * Confirm-with-password dialog for a checker's decision (ADR 0095). The password lives only in this component's state for the length of
 * one request: it is sent in the request body and cleared on every outcome. A failed or timed-out request shows an ErrorState with the server
 * request id and leaves the dialog open, so a wrong password can be retried without losing the page.
 */
function StepUpDialog({ request, onClose }: { request: StepUpRequest; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; requestId: string | null; final: boolean } | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || password.length === 0) return
    setBusy(true); setFailure(null)
    try { await request.run(password); setPassword(''); onClose() }
    catch (error) {
      setPassword('')
      const api = error instanceof ApiResponseError ? error : null
      setFailure({ message: describeApiError(error, 'complete this decision'), requestId: api?.requestId ?? null, final: api ? FINAL.has(api.code) : false })
    } finally { setBusy(false) }
  }

  return (
    <Modal title={request.title} onClose={() => { if (!busy) onClose() }}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }} data-testid="step-up-form">
        <p style={{ margin: 0, fontSize: 13 }}>{request.description}</p>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--c-444444)' }}>Confirm it is you: enter your own password. A different person made the request, and this decision is recorded under your name.</p>
        {!failure?.final && (
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>Your password
            <input className="input-wrap" type="password" autoComplete="current-password" value={password} maxLength={256} disabled={busy} required onChange={(e) => setPassword(e.target.value)} data-testid="step-up-password" />
          </label>
        )}
        {failure && (
          <div data-testid="step-up-error">
            <ErrorState title="Decision not completed" description={failure.requestId ? `${failure.message} (request ${failure.requestId})` : failure.message} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="admin-btn" disabled={busy} onClick={onClose}>{failure?.final ? 'Close' : 'Cancel'}</button>
          {!failure?.final && <button type="submit" className="admin-btn" disabled={busy || password.length === 0} data-testid="step-up-confirm">{busy ? 'Confirming…' : 'Confirm decision'}</button>}
        </div>
      </form>
    </Modal>
  )
}

/** `const { confirm, dialog } = useStepUp()`: render `{dialog}` once in the page and call `confirm({...})` from the approve button. */
export function useStepUp(): { confirm: (request: StepUpRequest) => void; dialog: ReactNode } {
  const [request, setRequest] = useState<StepUpRequest | null>(null)
  const close = useCallback(() => setRequest(null), [])
  return { confirm: setRequest, dialog: request ? <StepUpDialog request={request} onClose={close} /> : null }
}
