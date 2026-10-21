'use client'

import { useRef, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { describeApiError } from '@/lib/api/describe-error'
import { useCan } from '@/lib/auth/capabilities'
import { approveSettlement, getPostedPayables, getSettlements, proposeSettlement, rejectSettlement } from '@/lib/data/booking-finance-postings'
import { parseMajorToMinor } from '@/lib/minor-units'
import { SETTLEMENT_STATUS_TEXT, settlementTone } from '@/lib/booking-finance-posting-ui'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const

/**
 * Supplier settlements (ADR 0077): payments made to suppliers outside the system, recorded against their posted payables. One person proposes, a different person approves or
 * rejects. Nothing on this page moves money. The server decides who may do what and refuses an approval by the proposer; this page only shows what the server offers.
 */
export default function SupplierSettlementsPage() {
  const can = useCan()
  const [version, setVersion] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const list = useOpsQuery(() => getSettlements(), [version])
  const payables = useOpsQuery(() => getPostedPayables(), [version])
  const refresh = (m: string) => { setMessage(m); setVersion((v) => v + 1) }
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · SUPPLIER SETTLEMENTS" title="Supplier settlements" description="Payments made to suppliers outside the system, recorded against what is owed. One person proposes, a different person approves. Nothing here moves money; each currency is settled on its own." />
      {message && <p role="status" data-testid="settlement-message" style={{ fontSize: 12 }}>{message}</p>}
      {can('finance.settle.propose') && (
        <OpsState state={payables.state} onRetry={payables.reload}>
          {(d) => <ProposeForm options={d.rows.filter((r) => r.outstandingMinor !== '0' && !r.outstandingMinor.startsWith('-')).map((r) => ({ supplierId: r.supplierId, name: r.name ?? 'Unnamed supplier', currency: r.currency, outstandingMinor: r.outstandingMinor }))} onDone={refresh} />}
        </OpsState>
      )}
      <OpsState state={list.state} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No settlements', description: 'The query succeeded and no supplier payment has been recorded or proposed.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="settlements">
            <ScrollRegion label="Supplier settlements">
              <table style={tableStyle} aria-label="Supplier settlements">
                <thead><tr>{['Supplier', 'Amount', 'Paid on', 'Reference', 'Status', 'Proposed', 'Decision', ''].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.id}>
                    <td style={td}>{r.supplierName ?? 'Unnamed supplier'}</td>
                    <td style={{ ...td, textAlign: 'right' }}><Money minor={r.amountMinor} currency={r.currency} /></td>
                    <td style={td}>{r.paidOn}</td>
                    <td style={td}>{r.paymentReference}{r.note && <><br /><span style={{ fontSize: 10 }}>{r.note}</span></>}</td>
                    <td style={td}><Tag tone={settlementTone(r.status)}>{SETTLEMENT_STATUS_TEXT[r.status]}</Tag></td>
                    <td style={td}>{when(r.proposedAt)}</td>
                    <td style={td}>{r.decidedAt ? when(r.decidedAt) : '—'}{r.decisionReason && <><br /><span style={{ fontSize: 10 }}>{r.decisionReason}</span></>}</td>
                    <td style={td}>{r.status === 'PROPOSED' && can('finance.settle.approve') && <DecisionButtons id={r.id} onDone={refresh} />}</td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            {d.truncated && <p style={{ fontSize: 11, padding: '4px 14px' }}>Showing the newest {d.listLimit}.</p>}
          </div>
        )}
      </OpsState>
    </div>
  )
}

function DecisionButtons({ id, onDone }: { id: string; onDone: (message: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  async function run(kind: 'approve' | 'reject') {
    setBusy(true)
    try { if (kind === 'approve') { await approveSettlement(id); onDone('Settlement approved and recorded.') } else { await rejectSettlement(id, reason.trim()); onDone('Settlement rejected.') } }
    catch (error) { onDone(describeApiError(error, kind === 'approve' ? 'approve the settlement' : 'reject the settlement')) } finally { setBusy(false) }
  }
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {rejecting
        ? <><input className="input-wrap" aria-label="Reason for rejecting" placeholder="Reason (3+ characters)" value={reason} onChange={(e) => setReason(e.target.value)} /><button type="button" className="admin-btn" disabled={busy || reason.trim().length < 3} onClick={() => run('reject')}>Confirm reject</button></>
        : <><button type="button" className="admin-btn" disabled={busy} onClick={() => run('approve')}>Approve</button><button type="button" className="admin-btn" disabled={busy} onClick={() => setRejecting(true)}>Reject</button></>}
    </div>
  )
}

function ProposeForm({ options, onDone }: { options: Array<{ supplierId: string; name: string; currency: string; outstandingMinor: string }>; onDone: (message: string) => void }) {
  const [choice, setChoice] = useState(''); const [amount, setAmount] = useState(''); const [paidOn, setPaidOn] = useState(''); const [reference, setReference] = useState(''); const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const picked = options.find((o) => `${o.supplierId}|${o.currency}` === choice)
  const minor = picked ? parseMajorToMinor(amount, picked.currency) : null
  const ready = picked && minor !== null && minor !== '0' && paidOn && reference.trim().length >= 3
  async function submit() {
    if (!picked || !minor) return
    setBusy(true); setError(null)
    try {
      const requestId = (key.current ??= crypto.randomUUID())
      const view = await proposeSettlement({ supplierId: picked.supplierId, currency: picked.currency, amountMinor: minor, paidOn, paymentReference: reference.trim(), ...(note.trim() ? { note: note.trim() } : {}), requestId })
      key.current = null; setAmount(''); setReference(''); setNote('')
      onDone(`Proposed a payment of ${view.currency} to ${view.supplierName ?? 'the supplier'} for approval by a different person.`)
    } catch (err) { setError(describeApiError(err, 'propose the settlement')) } finally { setBusy(false) }
  }
  return (
    <section className="workspace-panel" aria-label="Propose a settlement" style={{ padding: '12px 18px', marginBottom: 12 }}>
      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Record a supplier payment</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={lab}>Supplier and currency
          <select className="input-wrap" value={choice} onChange={(e) => setChoice(e.target.value)} data-testid="settlement-supplier">
            <option value="">Choose</option>
            {options.map((o) => <option key={`${o.supplierId}|${o.currency}`} value={`${o.supplierId}|${o.currency}`}>{o.name} · {o.currency}</option>)}
          </select>
        </label>
        <label style={lab}>Amount paid{picked ? ` (${picked.currency})` : ''}<input className="input-wrap" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="450.00" data-testid="settlement-amount" /></label>
        <label style={lab}>Paid on<input className="input-wrap" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></label>
        <label style={lab}>Bank / transfer reference<input className="input-wrap" value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        <label style={lab}>Note (optional)<input className="input-wrap" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
        <button type="button" className="admin-btn" disabled={!ready || busy} onClick={submit} data-testid="settlement-submit">Propose</button>
      </div>
      {picked && <p style={{ fontSize: 11, color: '#3f565c', margin: '6px 0 0' }}>Still owed to this supplier in {picked.currency}: <Money minor={picked.outstandingMinor} currency={picked.currency} />. A payment can never exceed what is owed, counting proposals still waiting.</p>}
      {amount && picked && minor === null && <p role="alert" style={{ fontSize: 12, color: '#b42318' }}>Enter a positive amount with at most the currency's decimal places.</p>}
      {error && <p role="alert" style={{ fontSize: 12, color: '#b42318' }}>{error}</p>}
    </section>
  )
}
