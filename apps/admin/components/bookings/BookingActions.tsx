'use client'

import { useEffect, useState } from 'react'
import type { BookingAvailableAction, BookingDetailView } from '@bedbanks/contracts'
import { Money } from '@/components/ops/ops-ui'
import { quoteSummary } from '@/lib/booking-finance-ui'
import { getBookingFinance, patchBookingReferences, postBookingAction } from '@/lib/data/operations'
import { buildActionRequest, describeActionError, emptyActionForm, FIELD_LABEL, isOptional, MAX_LENGTH, newIdempotencyKey, visibleFields, type ActionFormState } from '@/lib/booking-actions-ui'
import { statusLabel } from '@/lib/booking-ui'
import { Modal } from './Modal'

const field: React.CSSProperties = { display: 'grid', gap: 3, fontSize: 12 }
const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '6px 8px', fontSize: 12, font: 'inherit' }

/** Before an operator asks for a cancellation they see what it costs (spec F.1). Shown only to callers who may see booking finance; absent otherwise, never zero. */
function useCancellationPreview(d: BookingDetailView, action: BookingAvailableAction): React.ReactNode {
  const allowed = action.action === 'requestCancellation' && d.access.level === 'OPERATOR' && d.access.permissions.includes('booking.finance.view')
  const [view, setView] = useState<Awaited<ReturnType<typeof getBookingFinance>> | 'failed' | null>(null)
  useEffect(() => { if (!allowed) return; let live = true; getBookingFinance(d.booking.id).then((v) => { if (live) setView(v) }, () => { if (live) setView('failed') }); return () => { live = false } }, [allowed, d.booking.id])
  if (!allowed) return null
  if (view === null) return <p role="status" style={{ margin: 0, fontSize: 12, color: '#3f565c' }}>Working out the penalty…</p>
  if (view === 'failed' || !view.cancellationPreview) return <p role="status" data-testid="cancel-preview" style={{ margin: 0, fontSize: 12, color: '#8a5a00' }}>The penalty could not be worked out here. It will be recorded when you ask for the cancellation.</p>
  const q = view.cancellationPreview
  return (
    <div role="status" data-testid="cancel-preview" style={{ border: '1px solid #e6d3a0', background: '#fffaf0', padding: 10, borderRadius: 6, fontSize: 12 }}>
      {q.status === 'quotable'
        ? <strong>Cancelling now costs a penalty of <Money minor={q.penaltyMinor} currency={view.currency} />; <Money minor={q.refundMinor} currency={view.currency} /> would be refunded.</strong>
        : <strong>The penalty cannot be worked out automatically; a person will decide it.</strong>}
      <div style={{ color: '#3f565c', fontSize: 11, marginTop: 2 }}>{quoteSummary(q)} The penalty is fixed when you submit this request.</div>
    </div>
  )
}

function ActionDialog({ d, action, onClose, onDone }: { d: BookingDetailView; action: BookingAvailableAction; onClose: () => void; onDone: (message: string) => void }) {
  const [form, setForm] = useState<ActionFormState>(emptyActionForm())
  const [key] = useState(newIdempotencyKey) // one key per dialog: a retry after a timeout replays instead of repeating
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReturnType<typeof describeActionError> | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const fields = visibleFields(action)
  const preview = useCancellationPreview(d, action)
  const set = (patch: Partial<ActionFormState>) => setForm((f) => ({ ...f, ...patch }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const built = buildActionRequest(action, d.booking.status, form)
    if ('missing' in built) { setMissing(built.missing); setError(null); return }
    setMissing([]); setBusy(true); setError(null)
    try {
      const { data } = await postBookingAction(d.booking.id, built.request, key)
      onDone(`${action.label}: ${d.booking.reference} is now ${statusLabel(data.status)}${data.closed ? ' and closed' : ''}.`)
    } catch (err) { setError(describeActionError(err)); setBusy(false) }
  }

  return (
    <Modal title={action.label} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 10 }} data-testid="booking-action-form">
        <p style={{ margin: 0, color: '#3f565c', fontSize: 12 }}>{d.booking.reference}: {statusLabel(d.booking.status)} → <strong>{statusLabel(action.to)}</strong>. {action.effect}</p>
        {preview}
        {fields.map((f) => (
          <label key={f} style={field}>
            <span>{FIELD_LABEL[f]}{isOptional(action, f) ? ' (optional)' : ' (required)'}</span>
            {f === 'reason'
              ? <textarea rows={3} maxLength={MAX_LENGTH.reason} value={form.reason} onChange={(e) => set({ reason: e.target.value })} style={input} aria-invalid={missing.includes('reason')} aria-describedby="reason-note" />
              : <input type="text" maxLength={MAX_LENGTH[f]} value={form[f] as string} onChange={(e) => set({ [f]: e.target.value } as Partial<ActionFormState>)} style={input} aria-invalid={missing.includes(f)} autoComplete="off" />}
            {f === 'reason' && <span id="reason-note" style={{ color: '#3f565c', fontSize: 11 }}>Do not enter guest personal details. Kept in the booking’s timeline for operators.</span>}
          </label>
        ))}
        {action.needsSecondConfirmation && (
          <label style={{ ...field, gridAutoFlow: 'column', justifyContent: 'start', alignItems: 'start', gap: 8 }}>
            <input type="checkbox" checked={form.confirmNonRefundable} onChange={(e) => set({ confirmNonRefundable: e.target.checked })} aria-invalid={missing.includes('confirmNonRefundable')} />
            <span>I understand this booking is not known to be refundable, and a penalty may apply.</span>
          </label>
        )}
        {missing.length > 0 && <p role="alert" style={{ margin: 0, color: '#a11d1d', fontSize: 12 }}>Required: {missing.map((m) => FIELD_LABEL[m as keyof typeof FIELD_LABEL]).join(', ')}.</p>}
        {error && (
          <div role="alert" data-testid="booking-action-error" style={{ color: '#a11d1d', fontSize: 12 }}>
            {error.message}{error.requestId ? <div style={{ fontSize: 11, color: '#3f565c' }}>Reference: request {error.requestId}</div> : null}
            {error.reload && <div><button type="button" className="admin-btn" onClick={() => onDone('')}>Reload booking</button></div>}
          </div>
        )}
        <div className="admin-modal-actions">
          <button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="admin-btn admin-btn-primary" disabled={busy} aria-busy={busy}>{busy ? 'Working…' : action.label}</button>
        </div>
      </form>
    </Modal>
  )
}

function ReferencesDialog({ d, onClose, onDone }: { d: BookingDetailView; onClose: () => void; onDone: (message: string) => void }) {
  const b = d.booking
  const [vals, setVals] = useState({ supplierRef: b.supplierRef ?? '', hotelConfirmationNo: b.hotelConfirmationNo ?? '', agentRef: b.agentRef ?? '', reason: '' })
  const [key] = useState(newIdempotencyKey); const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ReturnType<typeof describeActionError> | null>(null); const [note, setNote] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return
    if (!vals.reason.trim()) { setNote('A reason is required.'); return }
    const body = { reason: vals.reason.trim(), ...(vals.supplierRef.trim() !== (b.supplierRef ?? '') ? { supplierRef: vals.supplierRef.trim() || null } : {}), ...(vals.hotelConfirmationNo.trim() !== (b.hotelConfirmationNo ?? '') ? { hotelConfirmationNo: vals.hotelConfirmationNo.trim() || null } : {}), ...(vals.agentRef.trim() !== (b.agentRef ?? '') ? { agentRef: vals.agentRef.trim() || null } : {}) }
    if (Object.keys(body).length === 1) { setNote('Change at least one reference.'); return }
    setNote(null); setBusy(true); setError(null)
    try { await patchBookingReferences(b.id, body, key); onDone(`References updated on ${b.reference}.`) } catch (err) { setError(describeActionError(err)); setBusy(false) }
  }
  const row = (label: string, k: 'supplierRef' | 'hotelConfirmationNo' | 'agentRef') => (
    <label style={field}><span>{label}</span><input type="text" maxLength={64} value={vals[k]} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} style={input} autoComplete="off" /></label>
  )
  return (
    <Modal title="Edit references" onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 10 }} data-testid="booking-references-form">
        <p style={{ margin: 0, color: '#3f565c', fontSize: 12 }}>Changes the references only; the status stays {statusLabel(b.status)}. Clear a field to remove its reference.</p>
        {row('Supplier reference', 'supplierRef')}{row('Hotel confirmation number', 'hotelConfirmationNo')}{row('Agency’s own reference', 'agentRef')}
        <label style={field}><span>Reason (required)</span><textarea rows={2} maxLength={500} value={vals.reason} onChange={(e) => setVals((v) => ({ ...v, reason: e.target.value }))} style={input} /></label>
        {note && <p role="alert" style={{ margin: 0, color: '#a11d1d', fontSize: 12 }}>{note}</p>}
        {error && <div role="alert" style={{ color: '#a11d1d', fontSize: 12 }}>{error.message}{error.requestId ? <div style={{ fontSize: 11, color: '#3f565c' }}>Reference: request {error.requestId}</div> : null}</div>}
        <div className="admin-modal-actions"><button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="admin-btn admin-btn-primary" disabled={busy}>{busy ? 'Working…' : 'Save references'}</button></div>
      </form>
    </Modal>
  )
}

/** The actions this caller may take now, exactly as the API will accept them. A closed booking offers none. */
export function BookingActions({ d, onChanged }: { d: BookingDetailView; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState<BookingAvailableAction | 'references' | null>(null)
  const canEditRefs = d.access.level === 'OPERATOR' && d.access.permissions.includes('booking.supplier-ref.edit') && !d.booking.closedAt
  if (d.availableActions.length === 0 && !canEditRefs) return null
  const done = (message: string) => { setOpen(null); onChanged(message) }
  return (
    <div role="group" aria-label="Booking actions" data-testid="booking-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {d.availableActions.map((a) => <button key={a.action} type="button" className="admin-btn" data-action={a.action} onClick={() => setOpen(a)}>{a.label}</button>)}
      {canEditRefs && <button type="button" className="admin-btn" data-action="editReferences" onClick={() => setOpen('references')}>Edit references</button>}
      {open && open !== 'references' && <ActionDialog d={d} action={open} onClose={() => setOpen(null)} onDone={done} />}
      {open === 'references' && <ReferencesDialog d={d} onClose={() => setOpen(null)} onDone={done} />}
    </div>
  )
}
