'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { BOOKING_BULK_ACTION_LABEL, BOOKING_BULK_ITEM_ERROR_LABEL, BOOKING_BULK_MAX_IDS, type BookingBulkAction, type BookingBulkOperationView, type BookingBulkRequest, type BookingOpsAssignee } from '@bedbanks/contracts'
import { describeActionError, newIdempotencyKey } from '@/lib/booking-actions-ui'
import { failedIds, failureSummary, resultHeadline, selectionIds, selectionProblem, type Selection } from '@/lib/booking-bulk-ui'
import { getOpsAssignees, submitBulkAction } from '@/lib/data/operations'
import { Modal } from './Modal'

const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '6px 8px', fontSize: 12, font: 'inherit', color: '#1d333b', background: '#fff' }
const TONE = { ok: { bg: '#e8f5ee', fg: '#14532d' }, warn: { bg: '#fff4d6', fg: '#6b4a00' }, bad: { bg: '#fde8e8', fg: '#7f1d1d' } } as const

/** The bar that appears while bookings are selected. Starting an action only opens a confirmation; nothing runs until it is confirmed there. */
export function BulkToolbar({ selection, capabilities, onClear, onStart }: { selection: Selection; capabilities: readonly BookingBulkAction[]; onClear: () => void; onStart: (action: BookingBulkAction) => void }) {
  if (selection.size === 0) return null
  const problem = selectionProblem(selection)
  return (
    <div role="region" aria-label="Bulk actions" data-testid="bulk-toolbar" className="workspace-panel" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 14px', margin: '0 0 10px' }}>
      <strong data-testid="bulk-selected-count" role="status" aria-live="polite" style={{ fontSize: 12 }}>{selection.size} selected</strong>
      {capabilities.map((a) => <button key={a} type="button" className="admin-btn" data-testid={`bulk-start-${a}`} disabled={problem !== null} onClick={() => onStart(a)}>{BOOKING_BULK_ACTION_LABEL[a]}</button>)}
      <button type="button" className="admin-btn" data-testid="bulk-clear" onClick={onClear}>Clear selection</button>
      {problem && <span role="alert" style={{ color: '#a11d1d', fontSize: 11 }} data-testid="bulk-limit">{problem}</span>}
      <span style={{ color: '#3f565c', fontSize: 11 }}>Up to {BOOKING_BULK_MAX_IDS} bookings. Each is checked and updated on its own.</span>
    </div>
  )
}

/**
 * Confirmation, then result. The idempotency key is made once when the dialog opens, so a double click or a retry after a timeout returns the first
 * operation instead of running it twice. A partial result is shown as a result summary, never as a success message.
 */
export function BulkDialog({ action, selection, onClose, onDone }: { action: BookingBulkAction; selection: Selection; onClose: () => void; onDone: (op: BookingBulkOperationView) => void }) {
  const key = useRef(newIdempotencyKey()).current
  const [people, setPeople] = useState<BookingOpsAssignee[] | null>(null); const [peopleError, setPeopleError] = useState(false)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [result, setResult] = useState<BookingBulkOperationView | null>(null)
  useState(() => { if (action === 'ASSIGN_OWNER') void getOpsAssignees().then(setPeople).catch(() => setPeopleError(true)) })
  const ids = selectionIds(selection)

  async function confirm() {
    if (busy || !ids) return
    if (action === 'ASSIGN_OWNER' && !pick) { setError('Choose who should own these cases, or choose “Unassigned”.'); return }
    setBusy(true); setError(null)
    try {
      const body: BookingBulkRequest = action === 'ASSIGN_OWNER' ? { bookingIds: ids, action, payload: { assigneeUserId: pick === '__none' ? null : pick }, idempotencyKey: key } : { bookingIds: ids, action: 'ACKNOWLEDGE', payload: {}, idempotencyKey: key }
      const { data } = await submitBulkAction(body)
      setResult(data); onDone(data)
    } catch (err) { setError(describeActionError(err).message) } finally { setBusy(false) }
  }

  if (result) return <ResultSummary op={result} onClose={onClose} />
  return (
    <Modal title={BOOKING_BULK_ACTION_LABEL[action]} onClose={busy ? () => undefined : onClose}>
      <div style={{ display: 'grid', gap: 10 }} data-testid="bulk-confirm">
        <p style={{ margin: 0, fontSize: 12 }} data-testid="bulk-confirm-count">{action === 'ASSIGN_OWNER' ? 'Change the owner of' : 'Acknowledge'} <strong>{selection.size}</strong> selected booking{selection.size === 1 ? '' : 's'}?</p>
        {action === 'ASSIGN_OWNER' && (
          <label style={{ display: 'grid', gap: 3, fontSize: 12 }}><span style={{ color: "#2c4a55" }}>New owner</span>
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={input} data-testid="bulk-owner">
              <option value="">{peopleError ? 'Could not load people' : people ? 'Choose…' : 'Loading…'}</option>
              {people?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="__none">Unassigned</option>
            </select></label>
        )}
        <p style={{ margin: 0, fontSize: 11, color: '#3f565c' }}>Each booking is checked again and updated on its own, with your own permissions. Some may be refused (for example if they changed since you selected them); you will see exactly which. This does not touch money, documents or booking status.</p>
        {error && <p role="alert" style={{ margin: 0, color: '#a11d1d', fontSize: 12 }} data-testid="bulk-error">{error}</p>}
        <div className="admin-modal-actions"><button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="admin-btn admin-btn-primary" data-testid="bulk-confirm-submit" disabled={busy || !ids} aria-busy={busy} onClick={() => void confirm()}>{busy ? 'Working…' : 'Confirm'}</button></div>
      </div>
    </Modal>
  )
}

function ResultSummary({ op, onClose }: { op: BookingBulkOperationView; onClose: () => void }) {
  const head = resultHeadline(op); const tone = TONE[head.tone]; const reasons = failureSummary(op); const failed = op.items.filter((i) => i.status === 'FAILED')
  return (
    <Modal title="Bulk action result" onClose={onClose}>
      <div style={{ display: 'grid', gap: 10 }} data-testid="bulk-result" data-status={op.status}>
        <p role="status" data-testid="bulk-result-headline" style={{ margin: 0, padding: '8px 10px', borderRadius: 4, background: tone.bg, color: tone.fg, fontSize: 13, fontWeight: 600 }}>{head.text}</p>
        {op.replayed && <p style={{ margin: 0, fontSize: 11 }} data-testid="bulk-replayed">This is the result of the earlier request; nothing was applied again.</p>}
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: 0, fontSize: 12 }}>
          <dt>Requested</dt><dd style={{ margin: 0 }} data-testid="bulk-requested">{op.requestedCount}</dd>
          <dt>Succeeded</dt><dd style={{ margin: 0 }} data-testid="bulk-succeeded">{op.succeededCount}</dd>
          <dt>Failed</dt><dd style={{ margin: 0 }} data-testid="bulk-failed">{op.failedCount}</dd>
        </dl>
        {reasons.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }} data-testid="bulk-reasons">{reasons.map((r) => <li key={r.code} data-code={r.code}>{r.count} × {r.label}</li>)}</ul>}
        {failed.length > 0 && (
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }} aria-label="Bookings that were not updated" data-testid="bulk-failed-table">
              <thead><tr><th scope="col" style={{ textAlign: 'left' }}>Booking</th><th scope="col" style={{ textAlign: 'left' }}>Reason</th></tr></thead>
              <tbody>{failed.map((i) => <tr key={i.bookingId} data-code={i.errorCode ?? ''}><td>{i.reference ? <Link href={`/bookings/${encodeURIComponent(i.bookingId)}`}>{i.reference}</Link> : <span title="Not found, or not yours to see">Unknown booking</span>}</td><td>{i.errorCode ? BOOKING_BULK_ITEM_ERROR_LABEL[i.errorCode] : 'Could not be completed'}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <div className="admin-modal-actions"><button type="button" className="admin-btn admin-btn-primary" data-testid="bulk-result-close" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  )
}

export { failedIds }
