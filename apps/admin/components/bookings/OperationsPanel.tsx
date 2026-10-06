'use client'

import { useState } from 'react'
import {
  BOOKING_OPS_ANSWER_HELP, BOOKING_OPS_ANSWER_LABEL, BOOKING_OPS_ANSWER_RULES, BOOKING_OPS_MANUAL_PRIORITIES, BOOKING_OPS_PRIORITY_LABEL, BOOKING_OPS_REASON_LABEL, BOOKING_OPS_REASON_MIN, BOOKING_OPS_SAFE_ACTION_LABEL, BOOKING_OPS_SLA_LABEL,
  BOOKING_SUPPLIER_OP_LABEL, type BookingDetailView, type BookingOpsAnswer, type BookingOpsAssignee, type BookingSupplierOp,
} from '@bedbanks/contracts'
import { Tag } from '@/components/ops/ops-ui'
import { describeActionError, newIdempotencyKey } from '@/lib/booking-actions-ui'
import { formatRemaining, priorityTone, slaTone } from '@/lib/booking-ops-ui'
import { formatInZone, statusLabel } from '@/lib/booking-ui'
import { acknowledgeOpsCase, answerOpsCase, assignOpsCase, clearOpsCase, escalateOpsCase, getOpsAssignees, noteOpsCase, postBookingSupplier } from '@/lib/data/operations'
import { Modal } from './Modal'

const muted: React.CSSProperties = { color: '#3f565c' }
const field: React.CSSProperties = { display: 'grid', gap: 3, fontSize: 12 }
const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '6px 8px', fontSize: 12, font: 'inherit' }
const dl: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(150px, 220px) 1fr', gap: '6px 14px', margin: 0, fontSize: 12 }
type Dialog = null | 'assign' | 'escalate' | 'note' | 'clear' | 'answer'

/** A modal form with one idempotency key for its lifetime, a busy state, and the API's refusal in plain words. */
function FormDialog({ title, submitLabel, intro, onClose, onDone, run, children, valid = true }: { title: string; submitLabel: string; intro?: string; onClose: () => void; onDone: (m: string) => void; run: (key: string) => Promise<string>; children: React.ReactNode; valid?: boolean }) {
  const [key] = useState(newIdempotencyKey); const [busy, setBusy] = useState(false); const [error, setError] = useState<ReturnType<typeof describeActionError> | null>(null)
  async function submit(e: React.FormEvent) { e.preventDefault(); if (busy || !valid) return; setBusy(true); setError(null); try { onDone(await run(key)) } catch (err) { setError(describeActionError(err)); setBusy(false) } }
  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 10 }} data-testid="ops-dialog">
        {intro && <p style={{ margin: 0, ...muted, fontSize: 12 }}>{intro}</p>}
        {children}
        {error && <div role="alert" data-testid="ops-dialog-error" style={{ color: '#a11d1d', fontSize: 12 }}>{error.message}{error.requestId ? <div style={{ fontSize: 11, ...muted }}>Reference: request {error.requestId}</div> : null}</div>}
        <div className="admin-modal-actions"><button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="admin-btn admin-btn-primary" disabled={busy || !valid} aria-busy={busy}>{busy ? 'Working…' : submitLabel}</button></div>
      </form>
    </Modal>
  )
}
const Reason = ({ value, onChange, min = BOOKING_OPS_REASON_MIN, label = 'Reason' }: { value: string; onChange: (v: string) => void; min?: number; label?: string }) => (
  <label style={field}><span>{label} (required, at least {min} characters)</span><textarea rows={3} maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} style={input} /><span style={{ ...muted, fontSize: 11 }}>Do not enter guest personal details. Kept in the booking’s timeline for operators only.</span></label>
)

/** The operations case of one booking: why it is here, how urgent, by when, who owns it, and only the safe things to do next. */
export function OperationsPanel({ d, onChanged, refresh }: { d: BookingDetailView; onChanged: (message: string) => void; refresh: () => void }) {
  const op = d.operations
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [keys] = useState<Record<string, string>>({})
  if (!op) return null
  const i = op.item; const mine = i.assignee?.id === op.viewerId
  const done = (message: string) => { setDialog(null); onChanged(message) }
  const unknown = i.reasons.includes('SUPPLIER_UNKNOWN'); const cancelFailed = i.reasons.includes('CANCELLATION_FAILED')
  async function quick(name: string, fn: (key: string) => Promise<unknown>, message: string) {
    if (busy) return
    setBusy(name); setError(null); keys[name] ??= newIdempotencyKey()
    try { await fn(keys[name]); delete keys[name]; onChanged(message) } catch (e) { setError(describeActionError(e).message); delete keys[name] } finally { setBusy(null) }
  }
  const supplierOps = d.supplier?.ops ?? []
  const runSupplier = (opName: BookingSupplierOp) => quick(`supplier:${opName}`, (k) => postBookingSupplier(d.booking.id, { op: opName, expectedStatus: d.booking.status }, k), `${BOOKING_SUPPLIER_OP_LABEL[opName]}: queued.`)

  return (
    <section className="workspace-panel" style={{ padding: 16, display: 'grid', gap: 12 }} aria-labelledby="ops-h" data-testid="operations-panel">
      <h2 id="ops-h" style={{ fontSize: 14, margin: 0 }}>Operations</h2>
      {!i.inQueue ? <p style={{ ...muted, margin: 0, fontSize: 12 }} data-testid="ops-not-a-case">This booking is not an open operations case. {op.can.escalate ? 'You can still flag it for follow-up.' : ''}</p> : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Tag tone={priorityTone(i.priority)}>{BOOKING_OPS_PRIORITY_LABEL[i.priority].toUpperCase()}</Tag>
          <strong data-testid="ops-reason">{BOOKING_OPS_REASON_LABEL[i.primaryReason!]}</strong>
          {i.slaState && <Tag tone={slaTone(i.slaState)}>{BOOKING_OPS_SLA_LABEL[i.slaState].toUpperCase()}</Tag>}
          <span data-testid="ops-remaining">{formatRemaining(i.slaRemainingSeconds)}</span>
        </div>
      )}
      {unknown && <div role="alert" data-testid="ops-unknown" style={{ border: '1px solid #e0b4b4', background: '#fff7f7', padding: 10, borderRadius: 6, fontSize: 12 }}><strong>Supplier answer unknown.</strong> The supplier may already hold this booking, so it has <u>not</u> been marked failed and it must not be sent again: a second request could create a duplicate booking. Sync with the supplier, or record the supplier’s answer once you have it.</div>}
      {cancelFailed && <div role="alert" data-testid="ops-cancel-failed" style={{ border: '1px solid #e0b4b4', background: '#fff7f7', padding: 10, borderRadius: 6, fontSize: 12 }}><strong>Urgent — supplier cancellation not confirmed.</strong> The booking is still Cancel requested and the guest may still be exposed to the hotel’s penalty. Settle it with the supplier and record the outcome.</div>}
      <dl style={dl}>
        <dt style={muted}>Booking status</dt><dd style={{ margin: 0 }}>{statusLabel(i.status)}</dd>
        <dt style={muted}>Supplier</dt><dd style={{ margin: 0 }}>{i.supplier.name}{i.supplier.configured ? '' : ' (no supplier connection)'}</dd>
        <dt style={muted}>Supplier answer</dt><dd style={{ margin: 0 }}>{i.supplierStatus ? i.supplierStatus.replace(/_/g, ' ') : 'none yet'} · {i.supplierCertainty === 'UNCERTAIN' ? <strong>uncertain</strong> : 'certain'}</dd>
        <dt style={muted}>Last supplier activity</dt><dd style={{ margin: 0 }}>{i.lastSupplierActivityAt ? formatInZone(i.lastSupplierActivityAt, null) : 'none'}</dd>
        {i.inQueue && <><dt style={muted}>In the queue since</dt><dd style={{ margin: 0 }}>{formatInZone(i.enteredAt, null)}</dd>
          <dt style={muted}>SLA</dt><dd style={{ margin: 0 }}>{i.slaTargetMinutes} min target · due {formatInZone(i.slaDueAt, null)}</dd>
          <dt style={muted}>Owner</dt><dd style={{ margin: 0 }} data-testid="ops-owner">{i.assignee ? `${i.assignee.name}${mine ? ' (you)' : ''}${i.acknowledgedAt ? ` · acknowledged ${formatInZone(i.acknowledgedAt, null)}` : ' · not yet acknowledged'}` : 'Unassigned'}</dd>
          <dt style={muted}>Why this priority</dt><dd style={{ margin: 0 }}>{i.priorityFactors.join('; ')}</dd>
          <dt style={muted}>Next safe step</dt><dd style={{ margin: 0 }} data-testid="ops-safe-action">{i.safeAction ? BOOKING_OPS_SAFE_ACTION_LABEL[i.safeAction] : '—'}</dd></>}
      </dl>
      <div role="group" aria-label="Operations actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {op.can.assign && i.inQueue && !mine && <button type="button" className="admin-btn" disabled={busy !== null} data-action="claim" onClick={() => void quick('claim', (k) => assignOpsCase(d.booking.id, { assigneeUserId: op.viewerId, expectedVersion: i.opsVersion }, k), `${i.reference} is now yours.`)}>{i.assignee ? 'Take over' : 'Claim'}</button>}
        {op.can.assign && i.inQueue && <button type="button" className="admin-btn" disabled={busy !== null} data-action="assign" onClick={() => setDialog('assign')}>Assign to…</button>}
        {op.can.assign && i.inQueue && i.assignee && <button type="button" className="admin-btn" disabled={busy !== null} data-action="unassign" onClick={() => void quick('unassign', (k) => assignOpsCase(d.booking.id, { assigneeUserId: null, expectedVersion: i.opsVersion }, k), 'Unassigned.')}>Unassign</button>}
        {op.can.acknowledge && mine && !i.acknowledgedAt && <button type="button" className="admin-btn" disabled={busy !== null} data-action="acknowledge" onClick={() => void quick('ack', (k) => acknowledgeOpsCase(d.booking.id, { expectedVersion: i.opsVersion }, k), 'Acknowledged.')}>Acknowledge</button>}
        {op.can.escalate && <button type="button" className="admin-btn" disabled={busy !== null} data-action="escalate" onClick={() => setDialog('escalate')}>Escalate / flag follow-up</button>}
        {op.can.note && <button type="button" className="admin-btn" disabled={busy !== null} data-action="note" onClick={() => setDialog('note')}>Add note</button>}
        {op.can.clearFollowUp && <button type="button" className="admin-btn" disabled={busy !== null} data-action="clear" onClick={() => setDialog('clear')}>Resolve follow-up</button>}
        {op.can.answers.length > 0 && <button type="button" className="admin-btn" disabled={busy !== null} data-action="answer" onClick={() => setDialog('answer')}>Record supplier’s answer</button>}
      </div>
      {(supplierOps.length > 0 || unknown) && (
        <div role="group" aria-label="Safe supplier actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ ...muted, fontSize: 11 }}>Supplier:</span>
          {supplierOps.map((o) => <button key={o} type="button" className="admin-btn" disabled={busy !== null} data-supplier-op={o} aria-busy={busy === `supplier:${o}`} onClick={() => void runSupplier(o)}>{BOOKING_SUPPLIER_OP_LABEL[o]}</button>)}
          {unknown && !supplierOps.includes('send') && <span style={{ ...muted, fontSize: 11 }} data-testid="ops-send-withheld">“Send to supplier” is withheld while the answer is unknown.</span>}
        </div>
      )}
      {error && <div role="alert" data-testid="ops-error" style={{ color: '#a11d1d', fontSize: 12 }}>{error}</div>}
      <div>
        <h3 style={{ fontSize: 12, margin: '0 0 4px' }}>Operations timeline</h3>
        {op.timeline.length === 0 ? <p style={{ ...muted, fontSize: 12, margin: 0 }}>Nothing recorded yet.</p> : (
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 12 }} data-testid="ops-timeline">
            {op.timeline.map((t, n) => <li key={n} data-kind={t.kind}><strong>{t.title}</strong> <span style={muted}>· {formatInZone(t.at, null)}{t.actorName ? ` · ${t.actorName}` : ''}{t.kind === 'derived' ? ' · calculated' : ''}</span>{t.reason ? <div style={muted}>{t.reason}</div> : null}</li>)}
          </ol>
        )}
      </div>
      {dialog === 'assign' && <AssignDialog d={d} version={i.opsVersion} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'escalate' && <EscalateDialog d={d} version={i.opsVersion} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'note' && <NoteDialog d={d} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'clear' && <ClearDialog d={d} version={i.opsVersion} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'answer' && <AnswerDialog d={d} onClose={() => setDialog(null)} onDone={done} />}
      <button type="button" className="admin-btn" onClick={refresh} style={{ justifySelf: 'start' }}>Refresh</button>
    </section>
  )
}

function AssignDialog({ d, version, onClose, onDone }: { d: BookingDetailView; version: number; onClose: () => void; onDone: (m: string) => void }) {
  const [people, setPeople] = useState<BookingOpsAssignee[] | null>(null); const [pick, setPick] = useState(''); const [loadError, setLoadError] = useState(false)
  useState(() => { void getOpsAssignees().then(setPeople).catch(() => setLoadError(true)) })
  return (
    <FormDialog title="Assign this case" submitLabel="Assign" intro="Only staff of this tenant who can work the queue are listed." onClose={onClose} onDone={onDone} valid={Boolean(pick)}
      run={async (k) => { const { data } = await assignOpsCase(d.booking.id, { assigneeUserId: pick, expectedVersion: version }, k); return `${data.reference} assigned.` }}>
      <label style={field}><span>Assign to</span>
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={input} disabled={!people}><option value="">{loadError ? 'Could not load staff' : people ? 'Choose…' : 'Loading…'}</option>{people?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </FormDialog>
  )
}
function EscalateDialog({ d, version, onClose, onDone }: { d: BookingDetailView; version: number; onClose: () => void; onDone: (m: string) => void }) {
  const [priority, setPriority] = useState(''); const [followUp, setFollowUp] = useState(false); const [reason, setReason] = useState('')
  return (
    <FormDialog title="Escalate or flag for follow-up" submitLabel="Save" intro="An escalation raises the case; it never lowers the priority the system works out." onClose={onClose} onDone={onDone} valid={reason.trim().length >= BOOKING_OPS_REASON_MIN && (priority !== '' || followUp)}
      run={async (k) => { const { data } = await escalateOpsCase(d.booking.id, { priority: (priority || null) as never, followUp: followUp || undefined, reason: reason.trim(), expectedVersion: version }, k); return `${data.reference}: escalation saved.` }}>
      <label style={field}><span>Raise priority to</span><select value={priority} onChange={(e) => setPriority(e.target.value)} style={input}><option value="">No change</option>{BOOKING_OPS_MANUAL_PRIORITIES.map((p) => <option key={p} value={p}>{BOOKING_OPS_PRIORITY_LABEL[p]}</option>)}</select></label>
      <label style={{ ...field, gridAutoFlow: 'column', justifyContent: 'start', alignItems: 'center', gap: 8 }}><input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} /><span>Flag for manual follow-up (keeps it in the queue until resolved)</span></label>
      <Reason value={reason} onChange={setReason} />
    </FormDialog>
  )
}
function NoteDialog({ d, onClose, onDone }: { d: BookingDetailView; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <FormDialog title="Add an operations note" submitLabel="Add note" onClose={onClose} onDone={onDone} valid={note.trim().length >= 3} run={async (k) => { await noteOpsCase(d.booking.id, { note: note.trim() }, k); return 'Note added.' }}>
      <Reason value={note} onChange={setNote} min={3} label="Note" />
    </FormDialog>
  )
}
function ClearDialog({ d, version, onClose, onDone }: { d: BookingDetailView; version: number; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <FormDialog title="Resolve the manual follow-up" submitLabel="Resolve" intro="Clears the manual priority and follow-up flag. Reasons the system derives (such as an unknown supplier answer) are not cleared by this: they clear when the facts change." onClose={onClose} onDone={onDone} valid={reason.trim().length >= BOOKING_OPS_REASON_MIN}
      run={async (k) => { await clearOpsCase(d.booking.id, { reason: reason.trim(), expectedVersion: version }, k); return 'Follow-up resolved.' }}>
      <Reason value={reason} onChange={setReason} />
    </FormDialog>
  )
}
function AnswerDialog({ d, onClose, onDone }: { d: BookingDetailView; onClose: () => void; onDone: (m: string) => void }) {
  const answers = d.operations!.can.answers
  const [answer, setAnswer] = useState<BookingOpsAnswer | ''>(''); const [reason, setReason] = useState(''); const [supplierRef, setSupplierRef] = useState(''); const [hotelConf, setHotelConf] = useState(''); const [cancelRef, setCancelRef] = useState(''); const [evidence, setEvidence] = useState('')
  const rule = answer ? BOOKING_OPS_ANSWER_RULES[answer] : null
  const needsBookingRef = rule?.requires.includes('reference') && answer !== 'SUPPLIER_CANCELLED'; const needsCancelRef = answer === 'SUPPLIER_CANCELLED'; const needsEvidence = rule?.requires.includes('evidence')
  const valid = Boolean(answer) && reason.trim().length >= BOOKING_OPS_REASON_MIN && (!needsBookingRef || supplierRef.trim() !== '') && (!needsCancelRef || cancelRef.trim() !== '') && (!needsEvidence || evidence.trim().length >= 3)
  return (
    <FormDialog title="Record the supplier’s answer" submitLabel="Record answer" intro="Use this only when you have the answer from the supplier. It is recorded with your name and reason. It does not contact the supplier. There is no “mark failed”: a supplier rejection and “the supplier holds no booking” are different facts." onClose={onClose} onDone={onDone} valid={valid}
      run={async (k) => { const { data } = await answerOpsCase(d.booking.id, { answer: answer as BookingOpsAnswer, expectedStatus: d.booking.status, reason: reason.trim(), ...(supplierRef.trim() ? { supplierRef: supplierRef.trim() } : {}), ...(hotelConf.trim() ? { hotelConfirmationNo: hotelConf.trim() } : {}), ...(cancelRef.trim() ? { supplierCancellationRef: cancelRef.trim() } : {}), ...(evidence.trim() ? { evidenceRef: evidence.trim() } : {}) }, k); return `${data.reference}: answer recorded (now ${statusLabel(data.status)}).` }}>
      <label style={field}><span>The supplier’s answer</span>
        <select value={answer} onChange={(e) => setAnswer(e.target.value as BookingOpsAnswer | '')} style={input}><option value="">Choose…</option>{answers.map((a) => <option key={a} value={a}>{BOOKING_OPS_ANSWER_LABEL[a]}</option>)}</select></label>
      {answer && <p style={{ margin: 0, ...muted, fontSize: 12 }} data-testid="answer-help">{BOOKING_OPS_ANSWER_HELP[answer]}</p>}
      {(needsBookingRef || answer === 'SUPPLIER_CONFIRMED') && <label style={field}><span>Supplier’s booking reference{needsBookingRef ? ' (required)' : ''}</span><input value={supplierRef} maxLength={64} onChange={(e) => setSupplierRef(e.target.value)} style={input} autoComplete="off" /></label>}
      {answer === 'SUPPLIER_CONFIRMED' && <label style={field}><span>Hotel confirmation number (optional)</span><input value={hotelConf} maxLength={64} onChange={(e) => setHotelConf(e.target.value)} style={input} autoComplete="off" /></label>}
      {needsCancelRef && <label style={field}><span>Supplier’s cancellation reference (required)</span><input value={cancelRef} maxLength={64} onChange={(e) => setCancelRef(e.target.value)} style={input} autoComplete="off" /></label>}
      {needsEvidence && <label style={field}><span>Who at the supplier told you, and their reference (required)</span><input value={evidence} maxLength={160} onChange={(e) => setEvidence(e.target.value)} style={input} autoComplete="off" /></label>}
      <Reason value={reason} onChange={setReason} label="What you were told, and how" />
    </FormDialog>
  )
}
