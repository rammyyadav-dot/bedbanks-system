'use client'

import { useState } from 'react'
import type { BookingAvailableAction, BookingDetailView } from '@bedbanks/contracts'
import { postBookingAction } from '@/lib/data/operations'
import { describeActionError, MAX_LENGTH, newIdempotencyKey } from '@/lib/booking-actions-ui'
import { approvalPreview, buildAmendmentProposal, buildApproval, describeProposal, initialAmendmentForm, initialApprovalForm, openAmendment, type AmendmentApprovalForm, type AmendmentRequestForm } from '@/lib/booking-amendment-ui'
import { statusLabel } from '@/lib/booking-ui'
import { Modal } from './Modal'

const field: React.CSSProperties = { display: 'grid', gap: 3, fontSize: 12 }
const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '6px 8px', fontSize: 12, font: 'inherit' }
const muted: React.CSSProperties = { margin: 0, color: '#3f565c', fontSize: 12 }

function Errors({ problems, error, onReload }: { problems: string[]; error: ReturnType<typeof describeActionError> | null; onReload: () => void }) {
  return (
    <>
      {problems.length > 0 && <ul role="alert" data-testid="amendment-problems" style={{ margin: 0, paddingLeft: 18, color: '#a11d1d', fontSize: 12 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {error && (
        <div role="alert" data-testid="booking-action-error" style={{ color: '#a11d1d', fontSize: 12 }}>
          {error.message}{error.requestId ? <div style={{ fontSize: 11, color: '#3f565c' }}>Reference: request {error.requestId}</div> : null}
          {error.reload && <div><button type="button" className="admin-btn" onClick={onReload}>Reload booking</button></div>}
        </div>
      )}
    </>
  )
}

/**
 * Request an amendment (ADR 0072). Dates and room occupancy are structured and priced by the supplier when the request is approved; anything else (guest names, special requests)
 * is described in the note and is sent to the supplier directly. Leaving every structured field as it is sends a free-text request.
 */
export function RequestAmendmentDialog({ d, action, onClose, onDone }: { d: BookingDetailView; action: BookingAvailableAction; onClose: () => void; onDone: (message: string) => void }) {
  const [form, setForm] = useState<AmendmentRequestForm>(() => initialAmendmentForm(d))
  const [reason, setReason] = useState('')
  const [key] = useState(newIdempotencyKey)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<ReturnType<typeof describeActionError> | null>(null)
  const today = new Date().toISOString().slice(0, 10)
  const setRoom = (i: number, patch: Partial<AmendmentRequestForm['rooms'][number]>) => setForm((f) => ({ ...f, rooms: f.rooms.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const built = buildAmendmentProposal(form, d, today)
    const issues: string[] = []
    if (!reason.trim()) issues.push('A reason is required')
    if ('errors' in built) issues.push(...built.errors)
    if (issues.length) { setProblems(issues); setError(null); return }
    setProblems([]); setBusy(true); setError(null)
    try {
      await postBookingAction(d.booking.id, { action: 'requestAmendment', expectedStatus: d.booking.status, reason: reason.trim(), ...('proposal' in built ? { amendment: built.proposal } : {}) }, key)
      onDone(`Amendment requested on ${d.booking.reference}. It is now ${statusLabel('AMEND_REQUESTED')}.`)
    } catch (err) { setError(describeActionError(err)); setBusy(false) }
  }

  return (
    <Modal title={action.label} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 10 }} data-testid="amendment-request-form">
        <p style={muted}>{d.booking.reference}: change the stay dates and/or the people in each room. The supplier prices the change; its price is recorded when the amendment is approved. {action.effect}</p>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <label style={field}><span>Check-in</span><input type="date" value={form.checkIn} onChange={(e) => setForm((f) => ({ ...f, checkIn: e.target.value }))} style={input} data-testid="amend-check-in" /></label>
          <label style={field}><span>Check-out</span><input type="date" value={form.checkOut} onChange={(e) => setForm((f) => ({ ...f, checkOut: e.target.value }))} style={input} data-testid="amend-check-out" /></label>
        </div>
        {form.rooms.map((r, i) => (
          <fieldset key={r.position} style={{ border: '1px solid #e1eaec', borderRadius: 6, padding: 8, display: 'grid', gap: 6, gridTemplateColumns: '1fr 1fr 2fr' }}>
            <legend style={{ fontSize: 11 }}>{r.label}</legend>
            <label style={field}><span>Adults</span><input type="text" inputMode="numeric" value={r.adults} onChange={(e) => setRoom(i, { adults: e.target.value })} style={input} data-testid={`amend-adults-${r.position}`} /></label>
            <label style={field}><span>Children</span><input type="text" inputMode="numeric" value={r.children} onChange={(e) => setRoom(i, { children: e.target.value })} style={input} data-testid={`amend-children-${r.position}`} /></label>
            <label style={field}><span>Child ages (comma separated)</span><input type="text" value={r.childAges} onChange={(e) => setRoom(i, { childAges: e.target.value })} style={input} /></label>
          </fieldset>
        ))}
        <label style={field}>
          <span>Reason or other changes (required)</span>
          <textarea rows={3} maxLength={MAX_LENGTH.reason} value={reason} onChange={(e) => setReason(e.target.value)} style={input} aria-invalid={problems.some((p) => /reason/i.test(p))} />
          <span style={{ color: '#3f565c', fontSize: 11 }}>Name changes and special requests go in this note and are sent to the supplier directly. Do not enter guest personal details. Kept in the booking’s timeline for operators.</span>
        </label>
        <Errors problems={problems} error={error} onReload={() => onDone('')} />
        <div className="admin-modal-actions">
          <button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="admin-btn admin-btn-primary" disabled={busy} aria-busy={busy}>{busy ? 'Working…' : action.label}</button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Approve a structured amendment (ADR 0072): the approver records the price the supplier confirmed. The system works out the difference, applies the dates, occupancy, price
 * and deadline together, and records the difference as an amount awaiting Finance booking. It charges and refunds nothing.
 */
export function ApproveAmendmentDialog({ d, action, onClose, onDone }: { d: BookingDetailView; action: BookingAvailableAction; onClose: () => void; onDone: (message: string) => void }) {
  const open = openAmendment(d)!
  const currency = d.pricing.currency
  const [form, setForm] = useState<AmendmentApprovalForm>(() => initialApprovalForm(currency, { sellMinor: d.pricing.sellMinor, netMinor: d.pricing.netMinor }))
  const [key] = useState(newIdempotencyKey)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<ReturnType<typeof describeActionError> | null>(null)
  const preview = approvalPreview(d.pricing.sellMinor, form, currency)
  const stayChanges = Boolean(open.proposal.checkIn || open.proposal.checkOut)
  const netVisible = d.pricing.netVisibility === 'VISIBLE' || d.pricing.netVisibility === 'NOT_RECORDED'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const built = buildApproval(form, currency)
    if ('errors' in built) { setProblems(built.errors); setError(null); return }
    setProblems([]); setBusy(true); setError(null)
    try {
      await postBookingAction(d.booking.id, { action: 'approveAmendment', expectedStatus: d.booking.status, approval: built.approval }, key)
      onDone(`Amendment approved on ${d.booking.reference}: the new stay and price are recorded.`)
    } catch (err) { setError(describeActionError(err)); setBusy(false) }
  }

  return (
    <Modal title={action.label} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 10 }} data-testid="amendment-approve-form">
        <p style={muted}>{d.booking.reference}: the supplier agreed to the change below. Record the price they confirmed.</p>
        <ul data-testid="amendment-summary" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{describeProposal(open).map((line) => <li key={line}>{line}</li>)}</ul>
        <label style={field}><span>New sell total, {currency} (required)</span><input type="text" inputMode="decimal" value={form.sell} onChange={(e) => setForm((f) => ({ ...f, sell: e.target.value }))} style={input} data-testid="amend-sell" autoComplete="off" /></label>
        {!netVisible && <p data-testid="amendment-net-unknown" style={{ ...muted, fontSize: 11 }}>You cannot see net rates, so the net and the margin will be recorded as unknown. They are never kept at the old figures.</p>}
        {netVisible && <label style={field}><span>New net total, {currency} (optional)</span><input type="text" inputMode="decimal" value={form.net} onChange={(e) => setForm((f) => ({ ...f, net: e.target.value }))} style={input} data-testid="amend-net" autoComplete="off" /><span style={{ color: '#3f565c', fontSize: 11 }}>Left empty, the net and the margin become unknown rather than keeping the old figures.</span></label>}
        <label style={field}>
          <span>Free-cancellation deadline (optional)</span>
          <input type="datetime-local" value={form.deadline} onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))} style={input} />
          <span style={{ color: '#3f565c', fontSize: 11 }}>{stayChanges ? 'The dates are changing: left empty, the deadline becomes unknown until you edit it.' : 'Left empty, the current deadline is kept.'}</span>
        </label>
        {preview && <p role="status" data-testid="amendment-difference" data-tone={preview.tone} style={{ margin: 0, fontSize: 12, fontWeight: 600, color: preview.tone === 'up' ? '#8a5a00' : '#1f5f54' }}>{preview.text}</p>}
        <p style={{ ...muted, fontSize: 11 }}>Documents already issued (voucher, invoice) are not reissued by an amendment.</p>
        <Errors problems={problems} error={error} onReload={() => onDone('')} />
        <div className="admin-modal-actions">
          <button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="admin-btn admin-btn-primary" disabled={busy} aria-busy={busy}>{busy ? 'Working…' : 'Approve and apply'}</button>
        </div>
      </form>
    </Modal>
  )
}
