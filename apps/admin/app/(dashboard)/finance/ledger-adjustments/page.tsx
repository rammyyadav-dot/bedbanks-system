'use client'

import { useRef, useState } from 'react'
import {
  LEDGER_ADJUSTMENT_REASONS, LEDGER_ADJUSTMENT_STATUSES, LEDGER_REVERSAL_REASONS,
  type LedgerAdjustmentKindName, type LedgerAdjustmentProposeRequest, type LedgerAdjustmentView,
} from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { approveLedgerAdjustment, getLedgerAdjustments, proposeLedgerAdjustment, rejectLedgerAdjustment } from '@/lib/data/ledger-adjustments'
import { getAgencies } from '@/lib/data/departments'
import { describeApiError } from '@/lib/api/describe-error'
import { parseMajorToMinor } from '@/lib/minor-units'
import { useCan } from '@/lib/auth/capabilities'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-444444)' } as const
const note = { color: 'var(--c-444444)', fontSize: 11, margin: 0 } as const
const tone = (s: string) => (s === 'APPROVED' ? 'ok' : s === 'REJECTED' ? 'bad' : 'warn') as 'ok' | 'bad' | 'warn'
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ')
const ask = (label: string) => (typeof window === 'undefined' ? null : window.prompt(label)?.trim() ?? null)

/**
 * Ledger adjustments and payment reversals (ADR 0100). The server decides who may propose and who may decide; this page only shows what the
 * server says the caller can do. A proposal moves no money: approval, by a different person, posts one entry to the agency account.
 * Writes answer 503 until the deployment enables them, and that message is shown as it is.
 */
export default function LedgerAdjustmentsPage() {
  const can = useCan()
  const canPropose = can('finance.adjustment.propose'); const canApprove = can('finance.adjustment.approve')
  const [status, setStatus] = useState(''); const [kind, setKind] = useState(''); const [page, setPage] = useState(1); const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null)
  const data = useOpsQuery(() => getLedgerAdjustments({ status: status || undefined, kind: kind || undefined, page }), [status, kind, page, version])

  async function act(work: () => Promise<string>) {
    setBusy(true); setMessage(null)
    try { setMessage(await work()); setVersion(v => v + 1) } catch (error) { setMessage(describeApiError(error)) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader eyebrow="FINANCE" title="Adjustments and reversals" description="A correction on an agency account (a bank fee, an unidentified credit allocated, a goodwill credit) or a received payment taken back (a bank recall, a chargeback, a duplicate). One person proposes and a different person approves. Nothing moves until approval, which posts one entry to the account. A reversal can never take back more than its receipt paid." />
      {message && <p role="status" data-testid="adjustment-message" style={{ fontSize: 12 }}>{message}</p>}
      {canPropose && <Propose busy={busy} act={act} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', margin: '12px 0' }}>
        <label style={lab}>Status
          <select className="input-wrap" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">All</option>{LEDGER_ADJUSTMENT_STATUSES.map(s => <option key={s} value={s}>{words(s)}</option>)}
          </select>
        </label>
        <label style={lab}>Kind
          <select className="input-wrap" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1) }}>
            <option value="">All</option><option value="ADJUSTMENT">Adjustment</option><option value="REVERSAL">Reversal</option>
          </select>
        </label>
      </div>
      <OpsState state={data.state} onRetry={data.reload}>
        {(d) => d.items.length === 0 ? <p style={note}>No adjustments match.</p> : (
          <div className="workspace-panel">
            <ScrollRegion label="Adjustments and reversals">
              <table style={tableStyle}>
                <thead><tr>{['Proposed', 'Agency', 'Kind', 'Effect on account', 'Reason', 'Status', 'Actions'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map(r => <Row key={r.id} r={r} busy={busy} canApprove={canApprove} act={act} />)}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}

function Row({ r, busy, canApprove, act }: { r: LedgerAdjustmentView; busy: boolean; canApprove: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const debit = r.direction === 'DEBIT'
  return (
    <tr data-testid={`adjustment-${r.status.toLowerCase()}`}>
      <td style={td}>{when(r.proposedAt)}</td>
      <td style={td}><strong>{r.agencyName ?? r.agencyId}</strong></td>
      <td style={td}>{r.kind === 'REVERSAL' ? 'Reversal' : 'Adjustment'}{r.fundingReceiptId && <div style={{ fontSize: 10 }}>receipt <code>{r.fundingReceiptId}</code></div>}</td>
      <td style={{ ...td, textAlign: 'right' }}><Tag tone={debit ? 'warn' : 'ok'}>{debit ? 'debit' : 'credit'}</Tag> <Money minor={r.amountMinor} currency={r.currency} /></td>
      <td style={td}>{words(r.reason)}<div style={{ fontSize: 10 }}>{r.note}</div></td>
      <td style={td}><Tag tone={tone(r.status)}>{words(r.status)}</Tag>{r.decisionReason && <div style={{ fontSize: 10 }}>{r.decisionReason}</div>}</td>
      <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {canApprove && r.canDecide && <button type="button" className="admin-btn" disabled={busy} data-testid="adjustment-approve" onClick={() => { if (window.confirm(`Approve: this posts a ${debit ? 'debit' : 'credit'} to ${r.agencyName ?? 'the agency'}'s account.`)) void act(async () => { await approveLedgerAdjustment(r.id); return 'Approved and posted to the agency account.' }) }}>Approve</button>}
        {canApprove && r.canDecide && <button type="button" className="admin-btn" disabled={busy} data-testid="adjustment-reject" onClick={() => { const text = ask('Reason to reject (required)'); if (text) void act(async () => { await rejectLedgerAdjustment(r.id, text); return 'Rejected. Nothing was posted.' }) }}>Reject</button>}
        {r.status === 'PROPOSED' && !r.canDecide && <span style={{ fontSize: 10 }}>Waiting for a different approver</span>}
      </td>
    </tr>
  )
}

function Propose({ busy, act }: { busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const agencies = useOpsQuery(() => getAgencies({ pageSize: 100 }), [])
  const [kind, setKind] = useState<LedgerAdjustmentKindName>('ADJUSTMENT')
  const [agencyId, setAgencyId] = useState(''); const [amount, setAmount] = useState(''); const [direction, setDirection] = useState<'CREDIT' | 'DEBIT'>('DEBIT')
  const [reason, setReason] = useState<string>(LEDGER_ADJUSTMENT_REASONS[0]); const [text, setText] = useState(''); const [receiptId, setReceiptId] = useState('')
  const key = useRef<string | null>(null)
  const reasons: readonly string[] = kind === 'REVERSAL' ? LEDGER_REVERSAL_REASONS : LEDGER_ADJUSTMENT_REASONS
  // Currency is fixed to AED, the launch currency (ADR 0029); the server refuses an agency with no account in it.
  const minor = parseMajorToMinor(amount.trim(), 'AED')
  const ready = agencyId && minor && minor !== '0' && text.trim().length >= 3 && (kind === 'ADJUSTMENT' || receiptId.trim())
  function pick(next: LedgerAdjustmentKindName) { setKind(next); setReason((next === 'REVERSAL' ? LEDGER_REVERSAL_REASONS : LEDGER_ADJUSTMENT_REASONS)[0]); key.current = null }
  return (
    <section className="workspace-panel" aria-label="Propose an adjustment" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Propose</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={lab}>Kind
          <select className="input-wrap" value={kind} onChange={(e) => pick(e.target.value as LedgerAdjustmentKindName)} data-testid="adjustment-kind">
            <option value="ADJUSTMENT">Adjustment</option><option value="REVERSAL">Reversal of a payment</option>
          </select>
        </label>
        <label style={lab}>Agency
          <select className="input-wrap" value={agencyId} onChange={(e) => setAgencyId(e.target.value)} data-testid="adjustment-agency">
            <option value="">Choose</option>
            {agencies.state.status === 'ready' && agencies.state.data.items.map(a => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}
          </select>
        </label>
        {kind === 'ADJUSTMENT'
          ? <label style={lab}>Effect<select className="input-wrap" value={direction} onChange={(e) => setDirection(e.target.value as 'CREDIT' | 'DEBIT')}><option value="DEBIT">Debit (agency owes more)</option><option value="CREDIT">Credit (agency owes less)</option></select></label>
          : <label style={lab}>Funding receipt id<input className="input-wrap" maxLength={80} value={receiptId} onChange={(e) => setReceiptId(e.target.value)} data-testid="adjustment-receipt" /></label>}
        <label style={lab}>Amount (AED)<input className="input-wrap" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="adjustment-amount" /></label>
        <label style={lab}>Reason<select className="input-wrap" value={reason} onChange={(e) => setReason(e.target.value)}>{reasons.map(r => <option key={r} value={r}>{words(r)}</option>)}</select></label>
        <label style={lab}>Note<input className="input-wrap" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} data-testid="adjustment-note" /></label>
        <button type="button" className="admin-btn" disabled={busy || !ready} data-testid="adjustment-propose" onClick={() => void act(async () => {
          const requestId = (key.current ??= crypto.randomUUID())
          const body: LedgerAdjustmentProposeRequest = {
            requestId, kind, agencyId, currency: 'AED', amountMinor: minor as string, reason: reason as LedgerAdjustmentProposeRequest['reason'], note: text.trim(),
            ...(kind === 'REVERSAL' ? { fundingReceiptId: receiptId.trim() } : { direction }),
          }
          await proposeLedgerAdjustment(body)
          key.current = null; setAmount(''); setText(''); setReceiptId('')
          return 'Proposed. Nothing has moved; a different person must approve it.'
        })}>Propose</button>
      </div>
      <p style={note}>Do not put payer or guest personal data in the note. A reversal debits the account by the amount and is capped by what the receipt paid.</p>
    </section>
  )
}
