'use client'

import { useState } from 'react'
import { BOOKING_DOCUMENT_TYPES, type BookingDetailView, type BookingDocumentType, type BookingFinanceView } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { describeActionError, newIdempotencyKey } from '@/lib/booking-actions-ui'
import { DOCUMENT_BLOCK_COPY, DOCUMENT_LABEL, DOCUMENT_ROUTE, FINANCE_EVENT_LABEL, penaltySummary, quoteSummary } from '@/lib/booking-finance-ui'
import { bookingFinanceDocumentUrl, getBookingFinance, issueBookingDocument, postBookingPenalty } from '@/lib/data/operations'
import { parseMajorToMinor } from '@/lib/minor-units'
import { Modal } from './Modal'

const muted: React.CSSProperties = { color: '#3f565c' }
const th: React.CSSProperties = { textAlign: 'left', padding: '4px 8px', fontSize: 11, color: '#3f565c' }
const td: React.CSSProperties = { padding: '4px 8px', fontSize: 12, verticalAlign: 'top' }
const dl: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(150px, 230px) 1fr', gap: '6px 14px', margin: 0, fontSize: 12 }
const input: React.CSSProperties = { border: '1px solid #c5d4d8', borderRadius: 4, padding: '6px 8px', fontSize: 12, font: 'inherit' }

function PenaltyDialog({ f, mode, onClose, onDone }: { f: BookingFinanceView; mode: 'decide' | 'waive'; onClose: () => void; onDone: (message: string) => void }) {
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState('')
  const [key] = useState(newIdempotencyKey); const [busy, setBusy] = useState(false); const [note, setNote] = useState<string | null>(null)
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (busy) return
    const minor = parseMajorToMinor(amount, f.currency)
    if (minor === null) { setNote('Enter the penalty as a plain amount with at most the currency’s decimals.'); return }
    if (!reason.trim()) { setNote('A reason is required.'); return }
    setBusy(true); setNote(null)
    try { await postBookingPenalty(f.bookingId, { penaltyMinor: minor, reason: reason.trim() }, key); onDone(mode === 'waive' ? 'Penalty reduced.' : 'Penalty decided.') } catch (err) { setNote(describeActionError(err).message); setBusy(false) }
  }
  return (
    <Modal title={mode === 'waive' ? 'Waive part of the penalty' : 'Decide the penalty'} onClose={busy ? () => undefined : onClose}>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 10 }} data-testid="penalty-form">
        <p style={{ margin: 0, fontSize: 12, ...muted }}>
          {mode === 'waive' ? <>The penalty was fixed at <strong><Money minor={f.penalty.state === 'QUOTED' || f.penalty.state === 'DECIDED' || f.penalty.state === 'WAIVED' ? f.penalty.penaltyMinor : null} currency={f.currency} /></strong> when cancellation was requested. It can be reduced, never raised, and the person who requested the cancellation cannot approve this.</>
            : <>No rule fixed the penalty. Enter what the hotel is charging. It cannot be more than the booking total (<Money minor={f.sellMinor} currency={f.currency} />).</>}
        </p>
        <label style={{ display: 'grid', gap: 3, fontSize: 12 }}><span>New penalty ({f.currency})</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={input} placeholder="0.00" /></label>
        <label style={{ display: 'grid', gap: 3, fontSize: 12 }}><span>Reason (required)</span><textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} style={input} /><span style={{ ...muted, fontSize: 11 }}>Do not enter guest personal details.</span></label>
        {note && <p role="alert" style={{ margin: 0, color: '#a11d1d', fontSize: 12 }}>{note}</p>}
        <div className="admin-modal-actions"><button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="admin-btn admin-btn-primary" disabled={busy} aria-busy={busy}>{busy ? 'Working…' : mode === 'waive' ? 'Waive' : 'Decide'}</button></div>
      </form>
    </Modal>
  )
}

function Body({ f, onChanged }: { f: BookingFinanceView; onChanged: (message: string) => void }) {
  const [dialog, setDialog] = useState<'decide' | 'waive' | null>(null)
  const [busy, setBusy] = useState<BookingDocumentType | null>(null)
  const [error, setError] = useState<string | null>(null)
  const issued = new Map(f.documents.map((x) => [x.type, x]))
  const open = !f.closed && (f.status === 'CANCEL_REQUESTED' || f.status === 'CANCELLED') && !issued.has('CREDIT_NOTE') && !issued.has('CANCELLATION_NOTE')
  const decide = open && f.penalty.state === 'NEEDS_DECISION' && f.can.decidePenalty
  const waive = open && (f.penalty.state === 'QUOTED' || f.penalty.state === 'DECIDED' || f.penalty.state === 'WAIVED') && f.can.waivePenalty && f.penalty.penaltyMinor !== '0'
  const amounts = f.penalty.state === 'QUOTED' || f.penalty.state === 'DECIDED' || f.penalty.state === 'WAIVED' ? f.penalty : null

  async function issue(type: BookingDocumentType) {
    if (busy) return
    setBusy(type); setError(null)
    try { const { data } = await issueBookingDocument(f.bookingId, DOCUMENT_ROUTE[type]); onChanged(`${DOCUMENT_LABEL[type]} ${data.document.number} ${data.replayed ? 'was already issued' : 'issued'}.`) } catch (err) { setError(describeActionError(err).message) } finally { setBusy(null) }
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section className="workspace-panel" style={{ padding: 16 }} aria-labelledby="fin-money" data-testid="finance-summary">
        <h2 id="fin-money" style={{ fontSize: 14, margin: '0 0 8px' }}>Money</h2>
        <dl style={dl}>
          <dt>Sell total</dt><dd><Money minor={f.sellMinor} currency={f.currency} /></dd>
          {f.netMinor !== null && <><dt>Net cost</dt><dd><Money minor={f.netMinor} currency={f.currency} /></dd></>}
          <dt>Payment</dt><dd>{f.paymentMode ? f.paymentMode.replace(/_/g, ' ').toLowerCase() : <span style={muted}>not recorded</span>}</dd>
          <dt>Refundable</dt><dd>{f.isRefundable === null ? <span style={muted}>not known</span> : f.isRefundable ? 'Yes' : 'No: the whole amount is retained on cancellation'}</dd>
          <dt>Cancellation terms</dt>
          <dd>{f.terms.rules ? <ul style={{ margin: 0, paddingLeft: 16 }} data-testid="terms-list">{f.terms.rules.map((r, i) => <li key={i}>Within {r.daysBeforeCheckin} day(s) of check-in: {r.penaltyPercent !== undefined ? `${r.penaltyPercent}% of the total` : <Money minor={r.penaltyMinor ?? null} currency={f.currency} />}</li>)}</ul> : <span style={muted}>None stored with this booking. A cancellation’s penalty will need a person’s decision.</span>}</dd>
        </dl>
        <p style={{ ...muted, fontSize: 11, margin: '8px 0 0' }}>This module records money facts; it does not post to the ledger or move any balance. Finance books them.</p>
      </section>

      <section className="workspace-panel" style={{ padding: 16, display: 'grid', gap: 8 }} aria-labelledby="fin-penalty" data-testid="finance-penalty">
        <h2 id="fin-penalty" style={{ fontSize: 14, margin: 0 }}>Cancellation penalty</h2>
        {f.penalty.state === 'NOT_REQUESTED' ? (
          f.cancellationPreview
            ? <div data-testid="penalty-preview"><p style={{ margin: 0, fontSize: 12 }}>If this booking were cancelled now: {f.cancellationPreview.status === 'quotable'
              ? <strong>penalty <Money minor={f.cancellationPreview.penaltyMinor} currency={f.currency} />, refund <Money minor={f.cancellationPreview.refundMinor} currency={f.currency} /></strong> : <strong>penalty to be decided by a person</strong>}.</p><p style={{ ...muted, fontSize: 11, margin: '2px 0 0' }}>{quoteSummary(f.cancellationPreview)} The penalty is fixed when cancellation is requested.</p></div>
            : <p style={{ ...muted, margin: 0, fontSize: 12 }}>{penaltySummary(f.penalty)}</p>
        ) : (
          <div data-testid="penalty-state">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
              <Tag tone={amounts ? (f.penalty.state === 'WAIVED' ? 'ok' : 'warn') : 'bad'}>{f.penalty.state.replace('_', ' ')}</Tag>
              {amounts ? <span>Penalty <strong><Money minor={amounts.penaltyMinor} currency={f.currency} /></strong> · refund <strong><Money minor={amounts.refundMinor} currency={f.currency} /></strong>{f.penalty.waivedFrom ? <> · was <Money minor={f.penalty.waivedFrom} currency={f.currency} /></> : null}</span> : null}
            </div>
            <p style={{ ...muted, fontSize: 11, margin: '4px 0 0' }}>{penaltySummary(f.penalty)} {quoteSummary(f.penalty.quote)}</p>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {decide && <button type="button" className="admin-btn" data-action="decidePenalty" onClick={() => setDialog('decide')}>Decide penalty</button>}
              {waive && <button type="button" className="admin-btn" data-action="waivePenalty" onClick={() => setDialog('waive')}>Waive part of the penalty</button>}
            </div>
          </div>
        )}
      </section>

      <section className="workspace-panel" style={{ padding: 16, display: 'grid', gap: 8 }} aria-labelledby="fin-docs" data-testid="finance-documents">
        <h2 id="fin-docs" style={{ fontSize: 14, margin: 0 }}>Documents</h2>
        <p style={{ ...muted, fontSize: 11, margin: 0 }}>Each is issued once and never edited. Issuing does not send anything to anyone: notifications are not part of this release.</p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Booking documents"><thead><tr><th style={th}>Document</th><th style={th}>Number</th><th style={th}>Status</th><th style={th}>Action</th></tr></thead>
          <tbody>{BOOKING_DOCUMENT_TYPES.map((t) => {
            const done = issued.get(t); const block = f.eligible[t]
            return (
              <tr key={t} data-doc={t}>
                <td style={td}>{DOCUMENT_LABEL[t]}</td><td style={td}>{done?.number ?? '—'}</td>
                <td style={td}>{done ? <>Issued {when(done.issuedAt)}</> : block === null ? 'Ready to issue' : <span style={muted}>{block === 'ALREADY_ISSUED' ? 'Issued' : DOCUMENT_BLOCK_COPY[block]}</span>}</td>
                <td style={td}>{done ? <a className="admin-btn" href={bookingFinanceDocumentUrl(f.bookingId, DOCUMENT_ROUTE[t])} target="_blank" rel="noopener noreferrer">View / print</a>
                  : block === null && f.can.issueDocuments ? <button type="button" className="admin-btn" data-issue={t} disabled={busy !== null} aria-busy={busy === t} onClick={() => void issue(t)}>{busy === t ? 'Working…' : 'Issue'}</button> : null}</td>
              </tr>
            )
          })}</tbody></table>
        {error && <div role="alert" data-testid="finance-error" style={{ color: '#a11d1d', fontSize: 12 }}>{error}</div>}
      </section>

      <section className="workspace-panel" style={{ padding: 16, display: 'grid', gap: 8, overflowX: 'auto' }} aria-labelledby="fin-events" data-testid="finance-events">
        <h2 id="fin-events" style={{ fontSize: 14, margin: 0 }}>Money events</h2>
        {f.events.length === 0 ? <p style={{ ...muted, margin: 0, fontSize: 12 }}>None yet. A booking confirmed outside this module records its money elsewhere.</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }} aria-label="Money events"><thead><tr><th style={th}>When</th><th style={th}>Event</th><th style={th}>Sell</th><th style={th}>Penalty</th><th style={th}>Refund</th><th style={th}>Ledger</th></tr></thead>
            <tbody>{f.events.map((e) => <tr key={e.id}><td style={td}>{when(e.createdAt)}</td><td style={td}>{FINANCE_EVENT_LABEL[e.type]}{e.note ? <div style={{ ...muted, fontSize: 11 }}>{e.note}</div> : null}</td><td style={td}><Money minor={e.sellMinor} currency={e.currency} /></td><td style={td}><Money minor={e.penaltyMinor} currency={e.currency} /></td><td style={td}><Money minor={e.refundMinor} currency={e.currency} /></td><td style={td}><Tag tone="neutral">AWAITING FINANCE BOOKING</Tag></td></tr>)}</tbody></table>
        )}
      </section>
      {dialog && <PenaltyDialog f={f} mode={dialog} onClose={() => setDialog(null)} onDone={(m) => { setDialog(null); onChanged(m) }} />}
    </div>
  )
}

/** Money facts, cancellation terms, the penalty and the documents of one booking (ADR 0039, Phase 5). */
export function FinancePanel({ d, onChanged }: { d: BookingDetailView; onChanged: (message: string) => void }) {
  const { state, reload } = useOpsQuery(() => getBookingFinance(d.booking.id), [d.booking.id, d.booking.status, d.booking.closedAt])
  return <OpsState state={state} onRetry={reload}>{(f) => <Body f={f} onChanged={(m) => { reload(); onChanged(m) }} />}</OpsState>
}
