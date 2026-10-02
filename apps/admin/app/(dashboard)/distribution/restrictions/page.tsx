'use client'

import { useRef, useState } from 'react'
import { DISTRIBUTION_SCOPES, DISTRIBUTION_STATUSES } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { getSuppliers } from '@/lib/data'
import { getHotelsCommercial } from '@/lib/data/hotel-commercial'
import { createRestriction, getAgencies, getDistributionSummary, getRestrictions, retireRestriction } from '@/lib/data/departments'
import { describeApiError } from '@/lib/api/describe-error'

const PAGE_SIZE = 25
const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const field = { color: '#17333e' } as const

/** Distribution restrictions (ADR 0019): hide a hotel, or a supplier's inventory, from one agency's members. They narrow what an agency sees; they never grant access or change a price. */
export default function RestrictionsPage() {
  const [status, setStatus] = useState('ACTIVE'); const [page, setPage] = useState(1); const [version, setVersion] = useState(0)
  const list = useOpsQuery(() => getRestrictions({ status: status || undefined, page, pageSize: PAGE_SIZE }), [status, page, version])
  const summary = useOpsQuery(() => getDistributionSummary(), [version])
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  async function act(work: () => Promise<string>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try { setNotice({ tone: 'ok', text: await work() }); setVersion((v) => v + 1) } catch (e) { setNotice({ tone: 'bad', text: describeApiError(e, 'complete this step') }) } finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DISTRIBUTION" title="Restrictions" description="Hide a hotel, or everything from one supplier, from the members of one agency in Agent search, recheck and hold. A restriction only narrows what an agency sees. It never grants access or changes a price." />
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(s) => (
          <ul data-testid="distribution-summary" style={{ listStyle: 'none', margin: '0 0 10px', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
            {[['Active restrictions', s.active], ['Agencies restricted', s.agenciesRestricted], ['Hotel restrictions', s.byScope.hotel], ['Supplier restrictions', s.byScope.supplier], ['Members affected', s.membersAffected]].map(([l, v]) => (
              <li key={l as string} className="workspace-panel" style={{ padding: '10px 14px' }}><div style={{ font: '700 20px system-ui', color: '#17333e' }}>{v}</div><div style={{ color: '#3f565c', fontSize: 11 }}>{l}</div></li>
            ))}
          </ul>
        )}
      </OpsState>
      <NewRestriction busy={busy} onCreate={(b) => act(async () => { await createRestriction(b); return 'Restriction created. It applies to the agency\'s members straight away.' })} />
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="distribution-notice" style={{ margin: '8px 0' }}>{notice.text}</div>}
      <form aria-label="Restriction filters" onSubmit={(e) => e.preventDefault()} style={{ margin: '8px 0' }}>
        <label style={lab}>Status<select style={field} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">All</option>{DISTRIBUTION_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
      </form>
      <OpsState state={list.state} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No restrictions', description: 'No restriction matches. Every agency currently sees all inventory.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="restrictions-table">
            <ScrollRegion label="Restrictions">
              <table style={tableStyle} aria-label="Restrictions">
                <thead><tr>{['Agency', 'Hidden', 'Status', 'Reason', 'Created', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.id} data-testid={`restriction-${r.status.toLowerCase()}`}>
                    <td style={td}><strong>{r.agency.name}</strong><div style={{ fontSize: 10 }}><code>{r.agency.code}</code></div></td>
                    <td style={td}>{r.scope === 'HOTEL' ? `Hotel: ${r.hotel?.name}` : `All of supplier: ${r.supplier?.name}`}</td>
                    <td style={td}><Tag tone={r.status === 'ACTIVE' ? 'bad' : 'ok'}>{r.status}</Tag></td><td style={td}>{r.reason}</td><td style={td}>{when(r.createdAt)}{r.retiredAt ? <div style={{ fontSize: 10 }}>retired {when(r.retiredAt)}</div> : null}</td>
                    <td style={td}>{r.status === 'ACTIVE' ? <button type="button" className="admin-btn" disabled={busy} onClick={() => { if (window.confirm('Retire this restriction? The inventory becomes visible to the agency again.')) void act(async () => { await retireRestriction(r.id); return 'Restriction retired. The inventory is visible again.' }) }}>Retire</button> : '—'}</td>
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

function NewRestriction({ busy, onCreate }: { busy: boolean; onCreate: (b: { agencyId: string; scope: 'HOTEL' | 'SUPPLIER'; hotelId?: string; supplierId?: string; reason: string }) => void }) {
  const [agencyId, setAgencyId] = useState(''); const [scope, setScope] = useState<'HOTEL' | 'SUPPLIER'>('HOTEL'); const [hotelId, setHotelId] = useState(''); const [supplierId, setSupplierId] = useState(''); const [hotelSearch, setHotelSearch] = useState(''); const [reason, setReason] = useState('')
  const agencies = useOpsQuery(() => getAgencies({ pageSize: 100 }), [])
  const suppliers = useOpsQuery(() => (scope === 'SUPPLIER' ? getSuppliers('pageSize=100') : Promise.resolve(null)), [scope])
  const hotels = useOpsQuery(() => (scope === 'HOTEL' && hotelSearch.trim().length >= 2 ? getHotelsCommercial({ search: hotelSearch.trim(), pageSize: 10 }) : Promise.resolve(null)), [scope, hotelSearch])
  return (
    <form aria-label="New restriction" className="workspace-panel" data-testid="restriction-form" style={{ padding: '12px 18px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}
      onSubmit={(e) => { e.preventDefault(); onCreate({ agencyId, scope, ...(scope === 'HOTEL' ? { hotelId } : { supplierId }), reason }); setReason('') }}>
      <label style={lab}>Agency<select style={field} value={agencyId} onChange={(e) => setAgencyId(e.target.value)} required><option value="">Select…</option>{agencies.state.status === 'ready' && agencies.state.data.items.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.code})</option>)}</select></label>
      <label style={lab}>Hide<select style={field} value={scope} onChange={(e) => setScope(e.target.value as 'HOTEL' | 'SUPPLIER')}>{DISTRIBUTION_SCOPES.map((s) => <option key={s} value={s}>{s === 'HOTEL' ? 'One hotel' : 'All of one supplier'}</option>)}</select></label>
      {scope === 'HOTEL' && <>
        <label style={lab}>Find hotel<input style={field} value={hotelSearch} onChange={(e) => setHotelSearch(e.target.value)} placeholder="Type 2+ letters" /></label>
        <label style={lab}>Hotel<select style={field} value={hotelId} onChange={(e) => setHotelId(e.target.value)} required><option value="">Select…</option>{hotels.state.status === 'ready' && hotels.state.data?.items.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></label>
      </>}
      {scope === 'SUPPLIER' && <label style={lab}>Supplier<select style={field} value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required><option value="">Select…</option>{suppliers.state.status === 'ready' && suppliers.state.data?.items.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select></label>}
      <label style={lab}>Reason<input style={{ ...field, minWidth: 220 }} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} /></label>
      <button type="submit" className="admin-btn" disabled={busy}>Create restriction</button>
    </form>
  )
}
