'use client'

import { useRef, useState } from 'react'
import { MARKUP_MAX_BASIS_POINTS, MARKUP_SCOPES, MARKUP_STATUSES, type MarkupRuleView, type MarkupScopeName } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getSuppliers } from '@/lib/data'
import { getHotelsCommercial } from '@/lib/data/hotel-commercial'
import { cancelMarkupApproval, createMarkupRule, decideMarkupApproval, executeMarkupApproval, getMarkupRules, requestMarkupActivation, retireMarkupRule } from '@/lib/data/commercial'
import { describeApiError } from '@/lib/api/describe-error'

const PAGE_SIZE = 25
/** Basis points shown as a percent using integer arithmetic only (1250 is 12.50%). */
const percent = (bp: number) => `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`
const statusTone = (s: MarkupRuleView['status']) => (s === 'ACTIVE' ? 'ok' : s === 'RETIRED' ? 'bad' : 'warn') as 'ok' | 'bad' | 'warn'
const target = (r: MarkupRuleView) => (r.scope === 'TENANT_DEFAULT' ? 'All NET rates (default)' : r.scope === 'SUPPLIER' ? `Supplier: ${r.supplierName ?? r.supplierId}` : `Hotel: ${r.hotelName ?? r.hotelId}`)

/**
 * NET-rate markup rules (ADR 0018). The API prices every stay; this page only manages rules. A rule is immutable once created,
 * becomes ACTIVE only after a different person approves it, and the buttons shown come from the API's own flags.
 */
export default function MarkupsPage() {
  const [status, setStatus] = useState(''); const [scope, setScope] = useState(''); const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getMarkupRules({ status: status || undefined, scope: scope || undefined, page, pageSize: PAGE_SIZE }), [status, scope, page])
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
      <PageHeader eyebrow="COMMERCIAL" title="Markups" description="Percent markup on NET contract rates. Without an active rule a NET rate is not sold. A rule is immutable, and activating one needs a second person's approval." />
      <CreateRule onCreated={(text) => { setNotice({ tone: 'ok', text }); reload() }} />
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="markup-notice" style={{ margin: '8px 0' }}>{notice.text}</div>}
      <form aria-label="Markup filters" onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: 12, margin: '8px 0', color: '#3f565c', fontSize: 11 }}>
        <label style={{ display: 'grid', gap: 2, color: '#3f565c' }}>Status<select style={{ color: '#17333e' }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">All</option>{MARKUP_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label style={{ display: 'grid', gap: 2, color: '#3f565c' }}>Scope<select style={{ color: '#17333e' }} value={scope} onChange={(e) => { setScope(e.target.value); setPage(1) }}><option value="">All</option>{MARKUP_SCOPES.map((s) => <option key={s}>{s}</option>)}</select></label>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No markup rules', description: 'No rule matches. Until a rule is active, NET rates are not sellable.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="markups-table">
            <ScrollRegion label="Markup rules">
              <table style={tableStyle} aria-label="Markup rules">
                <thead><tr>{['Applies to', 'Markup', 'Valid', 'Status', 'Reason', 'Approval', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.id} data-testid={`markup-${r.status.toLowerCase()}`}>
                    <td style={td}>{target(r)}</td>
                    <td style={td}><strong>{percent(r.basisPoints)}</strong></td>
                    <td style={td}>{r.validFrom} → {r.validTo ?? 'open'}</td>
                    <td style={td}><Tag tone={statusTone(r.status)}>{r.status}</Tag></td>
                    <td style={td}>{r.reason}<div style={{ fontSize: 10 }}>created {when(r.createdAt)}</div></td>
                    <td style={td}>{r.approval ? <>{r.approval.status}{r.approval.decisionReason ? <div style={{ fontSize: 10 }}>{r.approval.decisionReason}</div> : null}</> : '—'}</td>
                    <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {r.canRequestActivation && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('request activation'); if (reason) void act(`q-${r.id}`, async () => { await requestMarkupActivation(r.id, { requestId: crypto.randomUUID(), reason }); return 'Activation requested.' }) }}>Request activation</button>}
                      {r.approval?.canDecide && <>
                        <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('approve'); if (reason) void act(`a-${r.id}`, async () => { await decideMarkupApproval(r.approval!.id, 'approve', reason); return 'Approved.' }) }}>Approve</button>
                        <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('reject'); if (reason) void act(`r-${r.id}`, async () => { await decideMarkupApproval(r.approval!.id, 'reject', reason); return 'Rejected.' }) }}>Reject</button>
                      </>}
                      {r.approval?.canCancel && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`c-${r.id}`, async () => { await cancelMarkupApproval(r.approval!.id); return 'Request cancelled.' })}>Cancel request</button>}
                      {r.approval?.canExecute && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`e-${r.id}`, async () => { const { data } = await executeMarkupApproval(r.approval!.id); return data.replacedRuleId ? 'Activated. The rule it replaced is retired.' : 'Activated.' })}>{busy === `e-${r.id}` ? 'Activating…' : 'Activate approved rule'}</button>}
                      {r.canRetire && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { if (window.confirm(r.status === 'ACTIVE' ? 'Retire this ACTIVE rule? NET rates it covers become unsellable unless another rule applies.' : 'Retire this draft?')) void act(`x-${r.id}`, async () => { await retireMarkupRule(r.id); return 'Retired.' }) }}>Retire</button>}
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

function CreateRule({ onCreated }: { onCreated: (text: string) => void }) {
  const [scope, setScope] = useState<MarkupScopeName>('TENANT_DEFAULT')
  const [percentInput, setPercentInput] = useState('10')
  const [validFrom, setValidFrom] = useState(''); const [validTo, setValidTo] = useState('')
  const [reason, setReason] = useState(''); const [supplierId, setSupplierId] = useState(''); const [hotelId, setHotelId] = useState(''); const [hotelSearch, setHotelSearch] = useState('')
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false)
  const suppliers = useOpsQuery(() => (scope === 'SUPPLIER' ? getSuppliers('pageSize=100') : Promise.resolve(null)), [scope])
  const hotels = useOpsQuery(() => (scope === 'HOTEL' && hotelSearch.trim().length >= 2 ? getHotelsCommercial({ search: hotelSearch.trim(), pageSize: 10 }) : Promise.resolve(null)), [scope, hotelSearch])

  /** Percent text to integer basis points without floating point: "12.5" is 1250. Anything else is refused. */
  function toBasisPoints(text: string): number | null {
    const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim())
    if (!m) return null
    const bp = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
    return bp <= MARKUP_MAX_BASIS_POINTS ? bp : null
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const basisPoints = toBasisPoints(percentInput)
    if (basisPoints === null) { setError('Enter a percent from 0 to 100 with at most two decimals.'); return }
    setBusy(true); setError(null)
    try {
      await createMarkupRule({ scope, ...(scope === 'SUPPLIER' && { supplierId }), ...(scope === 'HOTEL' && { hotelId }), basisPoints, validFrom, ...(validTo && { validTo }), reason })
      setReason(''); onCreated('Draft rule created. It changes no price until it is activated.')
    } catch (e) { setError(describeApiError(e, 'create the rule')) } finally { setBusy(false) }
  }
  const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
  const field = { color: '#17333e' } as const
  return (
    <form onSubmit={submit} aria-label="New markup rule" className="workspace-panel" style={{ padding: '12px 18px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }} data-testid="markup-form">
      <label style={lab}>Applies to<select style={field} value={scope} onChange={(e) => setScope(e.target.value as MarkupScopeName)}>{MARKUP_SCOPES.map((s) => <option key={s} value={s}>{s === 'TENANT_DEFAULT' ? 'All NET rates (default)' : s === 'SUPPLIER' ? 'One supplier' : 'One hotel'}</option>)}</select></label>
      {scope === 'SUPPLIER' && <label style={lab}>Supplier
        <select style={field} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required><option value="">Select…</option>{suppliers.state.status === 'ready' && suppliers.state.data?.items.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select>
        {suppliers.state.status === 'failed' && <span role="alert">Suppliers could not be loaded.</span>}</label>}
      {scope === 'HOTEL' && <>
        <label style={lab}>Find hotel<input style={field} value={hotelSearch} onChange={(e) => setHotelSearch(e.target.value)} placeholder="Type 2+ letters" /></label>
        <label style={lab}>Hotel<select style={field} value={hotelId} onChange={(e) => setHotelId(e.target.value)} required><option value="">Select…</option>{hotels.state.status === 'ready' && hotels.state.data?.items.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      </>}
      <label style={lab}>Markup %<input style={{ ...field, width: 80 }} inputMode="decimal" value={percentInput} onChange={(e) => setPercentInput(e.target.value)} required /></label>
      <label style={lab}>Valid from<input style={field} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} required /></label>
      <label style={lab}>Valid to (optional)<input style={field} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} /></label>
      <label style={lab}>Reason<input style={{ ...field, minWidth: 220 }} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required /></label>
      <button type="submit" className="admin-btn" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button>
      {error && <div className="admin-error" role="alert" style={{ flexBasis: '100%' }}>{error}</div>}
    </form>
  )
}
