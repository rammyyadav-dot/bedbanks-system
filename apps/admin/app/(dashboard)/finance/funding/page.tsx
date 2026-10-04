'use client'

import { useRef, useState } from 'react'
import { FUNDING_RECEIPT_STATUSES, type FundingReceiptView } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { clearFundingCompliance, declareFunding, getFundingReceipts, postFunding, rejectFunding, verifyFunding } from '@/lib/data/funding'
import { getAgencies } from '@/lib/data/departments'
import { describeApiError } from '@/lib/api/describe-error'
import { parseMajorToMinor } from '@/lib/minor-units'
import { useCan } from '@/lib/auth/capabilities'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const tone = (s: string) => (s === 'POSTED' ? 'ok' : s === 'REJECTED' ? 'bad' : s === 'VERIFIED' ? 'warn' : 'neutral') as 'ok' | 'bad' | 'warn' | 'neutral'
const ask = (label: string) => (typeof window === 'undefined' ? null : window.prompt(label)?.trim() ?? null)

/**
 * Funding receipts (ADR 0028 slice 2). The server decides every step and who may take it; this page only shows what the server says the
 * caller can do. Declared and verified receipts add nothing to any balance; posting credits the agency account.
 */
export default function FundingReceiptsPage() {
  const can = useCan()
  const canManage = can('funding.manage')
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1); const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null)
  const data = useOpsQuery(() => getFundingReceipts({ status: status || undefined, page }), [status, page, version])

  async function act(work: () => Promise<string>) {
    setBusy(true); setMessage(null)
    try { setMessage(await work()); setVersion(v => v + 1) } catch (error) { setMessage(describeApiError(error)) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageHeader eyebrow="FINANCE" title="Funding receipts" description="Bank transfers an agency has sent. A receipt is declared, verified against the bank statement by a different person, cleared by compliance when it is cash or from a third party, then posted. Only posting adds money to the agency's account. Above AED 10,000 the poster must also differ from the verifier." />
      {message && <p role="status" data-testid="funding-message" style={{ fontSize: 12 }}>{message}</p>}
      {canManage && <Declare busy={busy} act={act} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', margin: '12px 0' }}>
        <label style={lab}>Status
          <select className="input-wrap" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
            <option value="">All</option>{FUNDING_RECEIPT_STATUSES.map(s => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </select>
        </label>
      </div>
      <OpsState state={data.state} onRetry={data.reload}>
        {(d) => d.items.length === 0 ? <p style={note}>No receipts match.</p> : (
          <div className="workspace-panel">
            <ScrollRegion label="Funding receipts">
              <table style={tableStyle}>
                <thead><tr>{['Declared', 'Agency', 'Amount', 'Reference', 'Payer', 'Status', 'Checks', 'Actions'].map(h => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map(r => <Row key={r.id} r={r} busy={busy} canManage={canManage} act={act} />)}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}

function Row({ r, busy, canManage, act }: { r: FundingReceiptView; busy: boolean; canManage: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  return (
    <tr data-testid={`funding-${r.status.toLowerCase()}`}>
      <td style={td}>{when(r.declaredAt)}<div style={{ fontSize: 10 }}>{r.channel === 'AGENT' ? 'by the agency' : 'by finance'}</div></td>
      <td style={td}><strong>{r.agency.name}</strong> <code>{r.agency.code}</code></td>
      <td style={{ ...td, textAlign: 'right' }}><Money minor={r.amountMinor} currency={r.currency} /></td>
      <td style={td}><code>{r.bankReference}</code><div style={{ fontSize: 10 }}>{r.method === 'CASH_DEPOSIT' ? 'cash deposit' : 'bank transfer'}, value {r.valueDate}</div></td>
      <td style={td}>{r.payerName}{r.payerType === 'THIRD_PARTY' && <div><Tag tone="warn">third party</Tag></div>}</td>
      <td style={td}><Tag tone={tone(r.status)}>{r.status.toLowerCase()}</Tag>{r.rejectionReason && <div style={{ fontSize: 10 }}>{r.rejectionReason}</div>}</td>
      <td style={td}>
        {r.complianceReviewRequired && <div><Tag tone={r.complianceCleared ? 'ok' : 'warn'}>{r.complianceCleared ? 'compliance cleared' : 'compliance review'}</Tag></div>}
        {r.secondApprovalRequired && <div><Tag>second approver</Tag></div>}
        {r.postBlockedReason && <div style={{ fontSize: 10 }}>{r.postBlockedReason}</div>}
      </td>
      <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {canManage && r.canVerify && <button type="button" className="admin-btn" disabled={busy} data-testid="funding-verify" onClick={() => void act(async () => { await verifyFunding(r.id, ask('Verification note (optional), e.g. the statement line') ?? ''); return 'Verified.' })}>Verify</button>}
        {canManage && r.canClearCompliance && <button type="button" className="admin-btn" disabled={busy} data-testid="funding-clear" onClick={() => { const text = ask('Compliance note (required): what was checked'); if (text) void act(async () => { await clearFundingCompliance(r.id, text); return 'Compliance review cleared.' }) }}>Clear compliance</button>}
        {canManage && r.canPost && <button type="button" className="admin-btn" disabled={busy} data-testid="funding-post" onClick={() => { if (window.confirm('Post this receipt? The amount is credited to the agency account and cannot be undone here.')) void act(async () => { await postFunding(r.id); return 'Posted to the agency account.' }) }}>Post</button>}
        {canManage && r.canReject && <button type="button" className="admin-btn" disabled={busy} data-testid="funding-reject" onClick={() => { const text = ask('Reason to reject (required)'); if (text) void act(async () => { await rejectFunding(r.id, text); return 'Rejected.' }) }}>Reject</button>}
      </td>
    </tr>
  )
}

function Declare({ busy, act }: { busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const agencies = useOpsQuery(() => getAgencies({ pageSize: 100 }), [])
  const [agencyId, setAgencyId] = useState(''); const [amount, setAmount] = useState(''); const [reference, setReference] = useState('')
  const [valueDate, setValueDate] = useState(''); const [payerName, setPayerName] = useState('')
  const [method, setMethod] = useState<'BANK_TRANSFER' | 'CASH_DEPOSIT'>('BANK_TRANSFER'); const [payerType, setPayerType] = useState<'AGENCY' | 'THIRD_PARTY'>('AGENCY')
  const key = useRef<string | null>(null)
  const minor = parseMajorToMinor(amount.trim(), 'AED')
  const ready = agencyId && minor && minor !== '0' && reference.trim() && valueDate && payerName.trim()
  return (
    <section className="workspace-panel" aria-label="Declare a receipt" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Declare a receipt</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={lab}>Agency
          <select className="input-wrap" value={agencyId} onChange={(e) => setAgencyId(e.target.value)} data-testid="funding-agency">
            <option value="">Choose</option>
            {agencies.state.status === 'ready' && agencies.state.data.items.map(a => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}
          </select>
        </label>
        <label style={lab}>Amount (AED)<input className="input-wrap" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="funding-amount" /></label>
        <label style={lab}>Bank reference<input className="input-wrap" maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
        <label style={lab}>Value date<input className="input-wrap" type="date" value={valueDate} onChange={(e) => setValueDate(e.target.value)} /></label>
        <label style={lab}>Payer name<input className="input-wrap" maxLength={140} value={payerName} onChange={(e) => setPayerName(e.target.value)} /></label>
        <label style={lab}>Method<select className="input-wrap" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}><option value="BANK_TRANSFER">Bank transfer</option><option value="CASH_DEPOSIT">Cash deposit</option></select></label>
        <label style={lab}>Payer<select className="input-wrap" value={payerType} onChange={(e) => setPayerType(e.target.value as typeof payerType)}><option value="AGENCY">The agency</option><option value="THIRD_PARTY">Someone else</option></select></label>
        <button type="button" className="admin-btn" disabled={busy || !ready} data-testid="funding-declare" onClick={() => void act(async () => {
          const requestId = (key.current ??= crypto.randomUUID())
          await declareFunding({ agencyId, currency: 'AED', amountMinor: minor as string, method, bankReference: reference, valueDate, payerName, payerType, requestId })
          key.current = null; setAmount(''); setReference(''); setPayerName('')
          return 'Declared. A different person must verify it against the bank statement.'
        })}>Declare</button>
      </div>
      {(method === 'CASH_DEPOSIT' || payerType === 'THIRD_PARTY') && <p style={note}>Cash and third-party payments need a compliance review before they can be posted.</p>}
    </section>
  )
}
