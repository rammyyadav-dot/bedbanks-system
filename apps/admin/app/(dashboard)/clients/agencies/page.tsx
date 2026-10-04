'use client'

import { useRef, useState } from 'react'
import { AGENCY_STATUSES, type AgencyView } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { addAgencyMember, cancelAgencySuspension, createAgency, decideAgencySuspension, executeAgencySuspension, requestAgencySuspensionChange, getAgencies, getAgencyMembers, getClientsSummary, getMemberCandidates, removeAgencyMember, updateAgency } from '@/lib/data/departments'
import { AgencyCreditPanel } from '@/components/clients/AgencyCreditPanel'
import { AgencyAccountPanel } from '@/components/clients/AgencyAccountPanel'
import { useCan } from '@/lib/auth/capabilities'
import { describeApiError } from '@/lib/api/describe-error'

const PAGE_SIZE = 25
const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const field = { color: '#17333e' } as const

/** Agencies and their members (ADR 0019). INACTIVE is a directory state; SUSPENDED blocks the members from searching and booking and is reached only through a maker-checker request (ADR 0020). */
export default function AgenciesPage() {
  const [status, setStatus] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0); const [open, setOpen] = useState<string | null>(null); const [creditOpen, setCreditOpen] = useState<string | null>(null); const [accountOpen, setAccountOpen] = useState<string | null>(null)
  const canReadFinance = useCan()('finance.read')
  const list = useOpsQuery(() => getAgencies({ status: status || undefined, search: search.trim() || undefined, page, pageSize: PAGE_SIZE }), [status, search, page, version])
  const summary = useOpsQuery(() => getClientsSummary(), [version])
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  async function act(work: () => Promise<string>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try { setNotice({ tone: 'ok', text: await work() }); setVersion((v) => v + 1) } catch (e) { setNotice({ tone: 'bad', text: describeApiError(e, 'complete this step') }) } finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <div className="admin-page">
      <PageHeader eyebrow="AGENTS & CLIENTS" title="Agencies" description="Agency records and their members. An inactive agency still signs in, searches and books. A suspended agency cannot search, recheck, hold or book; suspending and reinstating need a second person's approval. A credit limit caps the holds an agency can place; setting one needs a second person's approval (Credit button). Pricing profiles and wallets are not managed here." />
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(s) => (
          <ul data-testid="clients-summary" style={{ listStyle: 'none', margin: '0 0 10px', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
            {[['Agencies', s.agencies.total], ['Active', s.agencies.active], ['Inactive', s.agencies.inactive], ['Suspended', s.agencies.suspended], ['Members in an agency', s.members.inAnAgency], ['Members in none', s.members.notInAnyAgency]].map(([l, v]) => (
              <li key={l as string} className="workspace-panel" style={{ padding: '10px 14px' }}><div style={{ font: '700 20px system-ui', color: '#17333e' }}>{v}</div><div style={{ color: '#3f565c', fontSize: 11 }}>{l}</div></li>
            ))}
          </ul>
        )}
      </OpsState>
      <CreateAgency busy={busy} onCreate={(body) => act(async () => { await createAgency(body); return 'Agency created.' })} />
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="clients-notice" style={{ margin: '8px 0' }}>{notice.text}</div>}
      <form aria-label="Agency filters" onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: 12, margin: '8px 0' }}>
        <label style={lab}>Search<input style={field} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Name or code" /></label>
        <label style={lab}>Status<select style={field} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">All</option>{AGENCY_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
      </form>
      <OpsState state={list.state} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No agencies', description: 'No agency matches. Create one above.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="agencies-table">
            <ScrollRegion label="Agencies">
              <table style={tableStyle} aria-label="Agencies">
                <thead><tr>{['Code', 'Name', 'Country', 'Status', 'Members', 'Created', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((a) => (
                  <tr key={a.id} data-testid={`agency-${a.status.toLowerCase()}`}>
                    <td style={td}><code>{a.code}</code></td><td style={td}><strong>{a.name}</strong>{a.notes ? <div style={{ fontSize: 10 }}>{a.notes}</div> : null}</td>
                    <td style={td}>{a.countryCode ?? '—'}</td><td style={td}><Tag tone={a.status === 'ACTIVE' ? 'ok' : a.status === 'SUSPENDED' ? 'bad' : 'warn'}>{a.status}</Tag></td><td style={td}>{a.memberCount}</td><td style={td}>{when(a.createdAt)}</td>
                    <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="admin-btn" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>Members</button>
                      <button type="button" className="admin-btn" aria-expanded={creditOpen === a.id} onClick={() => setCreditOpen(creditOpen === a.id ? null : a.id)}>Credit</button>
                      {canReadFinance && <button type="button" className="admin-btn" aria-expanded={accountOpen === a.id} data-testid="agency-account-toggle" onClick={() => setAccountOpen(accountOpen === a.id ? null : a.id)}>Account</button>}
                      <button type="button" className="admin-btn" disabled={busy} onClick={() => { const name = window.prompt('Agency name', a.name)?.trim(); if (name && name !== a.name) void act(async () => { await updateAgency(a.id, { name }); return 'Agency renamed.' }) }}>Rename</button>
                      {a.status !== 'SUSPENDED' && <button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await updateAgency(a.id, { status: a.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }); return a.status === 'ACTIVE' ? 'Agency marked inactive (directory only).' : 'Agency marked active.' })}>{a.status === 'ACTIVE' ? 'Mark inactive' : 'Mark active'}</button>}
                      <Suspension agency={a} busy={busy} act={act} />
                    </td>
                  </tr>))}</tbody>
              </table>
            </ScrollRegion>
            <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />
          </div>
        )}
      </OpsState>
      {open && <Members agencyId={open} version={version} busy={busy} act={act} />}
      {creditOpen && <AgencyCreditPanel agencyId={creditOpen} version={version} busy={busy} act={act} />}
      {accountOpen && canReadFinance && <AgencyAccountPanel agencyId={accountOpen} version={version} />}
    </div>
  )
}

const askReason = (verb: string) => (typeof window === 'undefined' ? '' : window.prompt(`Reason to ${verb} (required)`) ?? '').trim()

/** Maker-checker controls for one agency (ADR 0020). The server enforces a different approver and single use; the buttons only mirror it. */
function Suspension({ agency: a, busy, act }: { agency: AgencyView; busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const p = a.suspension
  if (!p) {
    const change = a.status === 'SUSPENDED' ? 'REINSTATE' : 'SUSPEND'
    const label = change === 'SUSPEND' ? 'Request suspension' : 'Request reinstatement'
    return <button type="button" className="admin-btn" disabled={busy} onClick={() => { const reason = askReason(label.toLowerCase()); if (reason) void act(async () => { await requestAgencySuspensionChange(a.id, { requestId: crypto.randomUUID(), change, reason }); return `${label.replace('Request ', '')} requested; a second person must approve it.` }) }}>{label}</button>
  }
  const what = p.change === 'SUSPEND' ? 'suspension' : 'reinstatement'
  return (
    <>
      <Tag tone="warn">{`${what} ${p.status.toLowerCase()}`}</Tag>
      {p.canDecide && <button type="button" className="admin-btn" disabled={busy} onClick={() => { const reason = askReason(`approve the ${what}`); if (reason) void act(async () => { await decideAgencySuspension(p.id, 'approve', reason); return 'Approved.' }) }}>Approve {what}</button>}
      {p.canDecide && <button type="button" className="admin-btn" disabled={busy} onClick={() => { const reason = askReason(`reject the ${what}`); if (reason) void act(async () => { await decideAgencySuspension(p.id, 'reject', reason); return 'Rejected.' }) }}>Reject</button>}
      {p.canCancel && <button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await cancelAgencySuspension(p.id); return 'Request withdrawn.' })}>Withdraw</button>}
      {p.canExecute && <button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await executeAgencySuspension(p.id); return p.change === 'SUSPEND' ? 'Agency suspended.' : 'Agency reinstated.' })}>Apply {what}</button>}
    </>
  )
}

function CreateAgency({ busy, onCreate }: { busy: boolean; onCreate: (b: { code: string; name: string; countryCode?: string; notes?: string }) => void }) {
  const [code, setCode] = useState(''); const [name, setName] = useState(''); const [country, setCountry] = useState(''); const [notes, setNotes] = useState('')
  return (
    <form aria-label="New agency" className="workspace-panel" data-testid="agency-form" style={{ padding: '12px 18px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}
      onSubmit={(e) => { e.preventDefault(); onCreate({ code, name, ...(country && { countryCode: country }), ...(notes && { notes }) }); setCode(''); setName(''); setCountry(''); setNotes('') }}>
      <label style={lab}>Code<input style={field} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required maxLength={40} placeholder="GULF-TRAVEL" /></label>
      <label style={lab}>Name<input style={{ ...field, minWidth: 200 }} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
      <label style={lab}>Country (ISO-2)<input style={{ ...field, width: 70 }} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} /></label>
      <label style={lab}>Notes<input style={{ ...field, minWidth: 200 }} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} /></label>
      <button type="submit" className="admin-btn" disabled={busy}>Create agency</button>
    </form>
  )
}

function Members({ agencyId, version, busy, act }: { agencyId: string; version: number; busy: boolean; act: (w: () => Promise<string>) => Promise<void> }) {
  const members = useOpsQuery(() => getAgencyMembers(agencyId), [agencyId, version])
  const cands = useOpsQuery(() => getMemberCandidates(), [agencyId, version])
  const [pick, setPick] = useState('')
  return (
    <section className="workspace-panel" aria-label="Agency members" data-testid="agency-members" style={{ padding: '12px 18px', marginTop: 12 }}>
      <h2 style={{ fontSize: 14 }}>Members</h2>
      <OpsState state={members.state} onRetry={members.reload} isEmpty={(m) => m.length === 0} empty={{ title: 'No members', description: 'No user belongs to this agency yet.' }}>
        {(m) => (
          <table style={tableStyle} aria-label="Members"><thead><tr>{['User', 'Account', 'Added', ''].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
            <tbody>{m.map((x) => (<tr key={x.userId}><td style={td}>{x.name ?? x.email}<div style={{ fontSize: 10 }}>{x.email}</div></td><td style={td}>{x.userStatus}</td><td style={td}>{when(x.addedAt)}</td>
              <td style={td}><button type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await removeAgencyMember(agencyId, x.userId); return 'Member removed.' })}>Remove</button></td></tr>))}</tbody></table>
        )}
      </OpsState>
      <form onSubmit={(e) => { e.preventDefault(); if (pick) void act(async () => { await addAgencyMember(agencyId, pick); setPick(''); return 'Member added.' }) }} style={{ display: 'flex', gap: 8, alignItems: 'end', marginTop: 8 }}>
        <label style={lab}>Add a user who is in no agency
          <select style={field} value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Select…</option>{cands.state.status === 'ready' && cands.state.data.map((c) => <option key={c.userId} value={c.userId}>{c.name ?? c.email}</option>)}</select>
        </label>
        <button type="submit" className="admin-btn" disabled={busy || !pick}>Add member</button>
      </form>
    </section>
  )
}
