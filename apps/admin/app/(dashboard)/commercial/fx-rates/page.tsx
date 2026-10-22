'use client'

import { useRef, useState } from 'react'
import { FX_MAX_BUFFER_BP, FX_RATE_STATUSES, type FxRateView } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { cancelFxApproval, createFxRate, decideFxApproval, executeFxApproval, getFxRates, requestFxActivation, retireFxRate } from '@/lib/data/commercial'
import { describeApiError } from '@/lib/api/describe-error'

const PAGE_SIZE = 25
/** Basis points shown as a percent using integer arithmetic only (150 is 1.50%). */
const percent = (bp: number) => `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`
const statusTone = (s: FxRateView['status']) => (s === 'ACTIVE' ? 'ok' : s === 'RETIRED' ? 'bad' : 'warn') as 'ok' | 'bad' | 'warn'

/**
 * Controlled FX rates (ADR 0067 F-12). The API converts every price; this page only manages rates. A rate is immutable once created,
 * becomes ACTIVE only after a different person approves it, and the buttons shown come from the API's own flags.
 */
export default function FxRatesPage() {
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getFxRates({ status: status || undefined, page, pageSize: PAGE_SIZE }), [status, page])
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const inFlight = useRef(false)

  async function act(key: string, work: () => Promise<string>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(key); setNotice(null)
    try { setNotice({ tone: 'ok', text: await work() }); reload() }
    catch (error) { setNotice({ tone: 'bad', text: describeApiError(error, 'complete this step') }) }
    finally { inFlight.current = false; setBusy(null) }
  }
  const ask = (verb: string) => (typeof window === 'undefined' ? '' : window.prompt(`Reason to ${verb} (required)`) ?? '').trim()

  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL" title="FX rates" description="Controlled exchange rates from a contract's currency into a selling currency. Without an active rate a contract is not offered in that currency. A rate is immutable, and activating one needs a second person's approval." />
      <CreateRate onCreated={(text) => { setNotice({ tone: 'ok', text }); reload() }} />
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="fx-notice" style={{ margin: '8px 0' }}>{notice.text}</div>}
      <form aria-label="FX rate filters" onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: 12, margin: '8px 0', color: 'var(--c-3f565c)', fontSize: 11 }}>
        <label style={{ display: 'grid', gap: 2, color: 'var(--c-3f565c)' }}>Status<select style={{ color: 'var(--c-17333e)' }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">All</option>{FX_RATE_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No FX rates', description: 'No rate matches. Contracts are offered only in their own currency until a rate is active.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="fx-table">
            <ScrollRegion label="FX rates">
              <table style={tableStyle} aria-label="FX rates">
                <thead><tr>{['Pair', 'Rate', 'Buffer', 'Effective', 'Status', 'Reason', 'Approval', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.id} data-testid={`fx-${r.status.toLowerCase()}`}>
                    <td style={td}><strong>{r.baseCurrency} → {r.quoteCurrency}</strong></td>
                    <td style={td}>1 {r.baseCurrency} = {r.rate} {r.quoteCurrency}</td>
                    <td style={td}>{percent(r.bufferBp)}</td>
                    <td style={td}>{r.effectiveRate}</td>
                    <td style={td}><Tag tone={statusTone(r.status)}>{r.status}</Tag>{r.activatedAt ? <div style={{ fontSize: 10 }}>since {when(r.activatedAt)}</div> : null}</td>
                    <td style={td}>{r.reason}<div style={{ fontSize: 10 }}>created {when(r.createdAt)}</div></td>
                    <td style={td}>{r.approval ? <>{r.approval.status}{r.approval.decisionReason ? <div style={{ fontSize: 10 }}>{r.approval.decisionReason}</div> : null}</> : '—'}</td>
                    <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {r.canRequestActivation && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('request activation'); if (reason) void act(`q-${r.id}`, async () => { await requestFxActivation(r.id, { requestId: crypto.randomUUID(), reason }); return 'Activation requested.' }) }}>Request activation</button>}
                      {r.approval?.canDecide && <>
                        <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('approve'); if (reason) void act(`a-${r.id}`, async () => { await decideFxApproval(r.approval!.id, 'approve', reason); return 'Approved.' }) }}>Approve</button>
                        <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('reject'); if (reason) void act(`r-${r.id}`, async () => { await decideFxApproval(r.approval!.id, 'reject', reason); return 'Rejected.' }) }}>Reject</button>
                      </>}
                      {r.approval?.canCancel && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`c-${r.id}`, async () => { await cancelFxApproval(r.approval!.id); return 'Request cancelled.' })}>Cancel request</button>}
                      {r.approval?.canExecute && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`e-${r.id}`, async () => { const { data } = await executeFxApproval(r.approval!.id); return data.replacedRateId ? 'Activated. The rate it replaced is retired; open offers re-check at the new rate.' : 'Activated.' })}>{busy === `e-${r.id}` ? 'Activating…' : 'Activate approved rate'}</button>}
                      {r.canRetire && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { if (window.confirm(r.status === 'ACTIVE' ? `Retire this ACTIVE rate? ${r.baseCurrency} contracts stop being offered in ${r.quoteCurrency}.` : 'Retire this draft?')) void act(`x-${r.id}`, async () => { await retireFxRate(r.id); return 'Retired.' }) }}>Retire</button>}
                    </td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
    </div>
  )
}

function CreateRate({ onCreated }: { onCreated: (text: string) => void }) {
  const [baseCurrency, setBase] = useState('AED'); const [quoteCurrency, setQuote] = useState('USD')
  const [rate, setRate] = useState(''); const [bufferInput, setBufferInput] = useState('0')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false)

  /** Percent text to integer basis points without floating point: "1.5" is 150. Anything else is refused. */
  function toBasisPoints(text: string): number | null {
    const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim())
    if (!m) return null
    const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
    return bp <= FX_MAX_BUFFER_BP ? bp : null
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const bufferBp = toBasisPoints(bufferInput)
    if (bufferBp === null) { setError(`Enter a buffer from 0 to ${FX_MAX_BUFFER_BP / 100}% with at most two decimals.`); return }
    if (!/^\d{1,9}(\.\d{1,8})?$/.test(rate.trim())) { setError('Enter the rate as a decimal with at most eight places, e.g. 0.27229.'); return }
    setBusy(true); setError(null)
    try {
      await createFxRate({ baseCurrency: baseCurrency.trim().toUpperCase(), quoteCurrency: quoteCurrency.trim().toUpperCase(), rate: rate.trim(), bufferBp, reason })
      setReason(''); onCreated('Draft rate created. It changes no price until it is activated.')
    } catch (e) { setError(describeApiError(e, 'create the rate')) } finally { setBusy(false) }
  }
  const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-3f565c)' } as const
  const field = { color: 'var(--c-17333e)' } as const
  return (
    <form onSubmit={submit} aria-label="New FX rate" className="workspace-panel" style={{ padding: '12px 18px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }} data-testid="fx-form">
      <label style={lab} title="The contract (settlement) currency">From<input style={{ ...field, width: 60 }} maxLength={3} value={baseCurrency} onChange={(e) => setBase(e.target.value.toUpperCase())} required /></label>
      <label style={lab} title="The currency agents search and book in">To<input style={{ ...field, width: 60 }} maxLength={3} value={quoteCurrency} onChange={(e) => setQuote(e.target.value.toUpperCase())} required /></label>
      <label style={lab} title={`Units of ${quoteCurrency || 'quote'} per one ${baseCurrency || 'base'}`}>Rate<input style={{ ...field, width: 120 }} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.27229" required /></label>
      <label style={lab} title="Added on top of the rate to cover movement until settlement">Buffer %<input style={{ ...field, width: 70 }} inputMode="decimal" value={bufferInput} onChange={(e) => setBufferInput(e.target.value)} required /></label>
      <label style={lab}>Reason<input style={{ ...field, minWidth: 220 }} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required /></label>
      <button type="submit" className="admin-btn" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button>
      {error && <div className="admin-error" role="alert" style={{ flexBasis: '100%' }}>{error}</div>}
    </form>
  )
}
