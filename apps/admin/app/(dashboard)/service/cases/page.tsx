'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { CASE_CATEGORIES, CASE_PRIORITIES, CASE_STATUSES, type CasePriority, type CaseView } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { createCase, getCaseAssignees, getCases, getServiceSummary } from '@/lib/data/departments'
import { describeApiError } from '@/lib/api/describe-error'

const PAGE_SIZE = 25
const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const field = { color: '#17333e' } as const
const prioTone = (p: CasePriority) => (p === 'URGENT' ? 'bad' : p === 'HIGH' ? 'warn' : 'ok') as 'bad' | 'warn' | 'ok'
const caseStatusTone = (s: CaseView['status']) => (s === 'CLOSED' ? 'ok' : s === 'RESOLVED' ? 'ok' : s === 'IN_PROGRESS' ? 'warn' : 'bad') as 'ok' | 'warn' | 'bad'

/** Service cases (ADR 0019). A case observes other records and never changes them. */
export default function CasesPage() {
  const [status, setStatus] = useState('UNRESOLVED'); const [priority, setPriority] = useState(''); const [assignee, setAssignee] = useState(''); const [search, setSearch] = useState(''); const [page, setPage] = useState(1)
  const [version, setVersion] = useState(0)
  const list = useOpsQuery(() => getCases({ status: status || undefined, priority: priority || undefined, assignee: assignee || undefined, search: search.trim() || undefined, page, pageSize: PAGE_SIZE }), [status, priority, assignee, search, page, version])
  const summary = useOpsQuery(() => getServiceSummary(), [version])
  return (
    <div className="admin-page">
      <PageHeader eyebrow="SERVICE OPERATIONS" title="Cases" description="Support cases linked to bookings, hotels, suppliers and agencies. Cases record and track the work; they never change the records they refer to. Do not enter guest names, contact details or card data." />
      <OpsState state={summary.state} onRetry={summary.reload}>
        {(s) => (
          <ul data-testid="service-summary" style={{ listStyle: 'none', margin: '0 0 10px', padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
            {[['Open', s.byStatus.open], ['In progress', s.byStatus.inProgress], ['Resolved', s.byStatus.resolved], ['Unassigned', s.unassigned], ['Urgent unresolved', s.urgentUnresolved]].map(([l, v]) => (
              <li key={l as string} className="workspace-panel" style={{ padding: '10px 14px' }}><div style={{ font: '700 20px system-ui', color: '#17333e' }}>{v}</div><div style={{ color: '#3f565c', fontSize: 11 }}>{l}</div></li>
            ))}
          </ul>
        )}
      </OpsState>
      <NewCase onCreated={() => setVersion((v) => v + 1)} />
      <form aria-label="Case filters" onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '8px 0' }}>
        <label style={lab}>Search<input style={field} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Reference or subject" /></label>
        <label style={lab}>Status<select style={field} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="UNRESOLVED">Unresolved</option><option value="">All</option>{CASE_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label style={lab}>Priority<select style={field} value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1) }}><option value="">All</option>{CASE_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label style={lab}>Assigned<select style={field} value={assignee} onChange={(e) => { setAssignee(e.target.value); setPage(1) }}><option value="">Anyone</option><option value="me">Me</option><option value="none">Unassigned</option></select></label>
      </form>
      <OpsState state={list.state} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No cases', description: 'No case matches these filters.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="cases-table">
            <ScrollRegion label="Cases">
              <table style={tableStyle} aria-label="Cases">
                <thead><tr>{['Reference', 'Subject', 'Category', 'Priority', 'Status', 'Assigned', 'Opened'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((c) => (
                  <tr key={c.id} data-priority={c.priority}>
                    <td style={td}><Link href={`/service/cases/${c.id}`}><code>{c.reference}</code></Link></td><td style={td}>{c.subject}</td><td style={td}>{c.category}</td>
                    <td style={td}><Tag tone={prioTone(c.priority)}>{c.priority}</Tag></td><td style={td}><Tag tone={caseStatusTone(c.status)}>{c.status.split('_').join(' ')}</Tag></td>
                    <td style={td}>{c.assignee?.email ?? '—'}</td><td style={td}>{when(c.createdAt)}</td>
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

function NewCase({ onCreated }: { onCreated: () => void }) {
  const [subject, setSubject] = useState(''); const [description, setDescription] = useState(''); const [category, setCategory] = useState<string>('BOOKING'); const [priority, setPriority] = useState<string>('NORMAL'); const [assigneeId, setAssigneeId] = useState('')
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const assignees = useOpsQuery(() => getCaseAssignees(), [])
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null)
    try { await createCase({ subject, description, category: category as never, priority: priority as CasePriority, ...(assigneeId && { assigneeId }) }); setSubject(''); setDescription(''); onCreated() }
    catch (err) { setError(describeApiError(err, 'open the case')) } finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <form onSubmit={submit} aria-label="New case" className="workspace-panel" data-testid="case-form" style={{ padding: '12px 18px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
      <label style={lab}>Subject<input style={{ ...field, minWidth: 240 }} value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={200} /></label>
      <label style={lab}>Category<select style={field} value={category} onChange={(e) => setCategory(e.target.value)}>{CASE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label style={lab}>Priority<select style={field} value={priority} onChange={(e) => setPriority(e.target.value)}>{CASE_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
      <label style={lab}>Assign to<select style={field} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}><option value="">Unassigned</option>{assignees.state.status === 'ready' && assignees.state.data.map((a) => <option key={a.id} value={a.id}>{a.name ?? a.email}</option>)}</select></label>
      <label style={{ ...lab, flexBasis: '100%' }}>Description<textarea style={{ ...field, minHeight: 60 }} value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={2000} /></label>
      <button type="submit" className="admin-btn" disabled={busy}>{busy ? 'Opening…' : 'Open case'}</button>
      {error && <div className="admin-error" role="alert" style={{ flexBasis: '100%' }}>{error}</div>}
    </form>
  )
}
