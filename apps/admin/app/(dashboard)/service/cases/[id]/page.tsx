'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useRef, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { addCaseNote, assignCase, getCase, getCaseAssignees, transitionCase } from '@/lib/data/departments'
import { describeApiError } from '@/lib/api/describe-error'

const lab = { display: 'grid', gap: 2, fontSize: 11, color: '#3f565c' } as const
const field = { color: '#17333e' } as const
const verb: Record<string, string> = { IN_PROGRESS: 'Start work', OPEN: 'Reopen as open', RESOLVED: 'Mark resolved', CLOSED: 'Close case' }

/** One case: its details, an append-only note trail, and the moves its status allows. */
export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [version, setVersion] = useState(0)
  const detail = useOpsQuery(() => getCase(id), [id, version])
  const assignees = useOpsQuery(() => getCaseAssignees(), [])
  const [note, setNote] = useState(''); const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  async function act(work: () => Promise<string>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setNotice(null)
    try { setNotice({ tone: 'ok', text: await work() }); setVersion((v) => v + 1) } catch (e) { setNotice({ tone: 'bad', text: describeApiError(e, 'update the case') }) } finally { inFlight.current = false; setBusy(false) }
  }
  return (
    <div className="admin-page">
      <OpsState state={detail.state} onRetry={detail.reload}>
        {(c) => (
          <>
            <PageHeader eyebrow={`CASE · ${c.reference}`} title={c.subject} description={`${c.category} · opened by ${c.openedByEmail} ${when(c.createdAt)}`} actions={<Link href="/service/cases">All cases</Link>} />
            <section className="workspace-panel" style={{ padding: '12px 18px', marginBottom: 12 }} data-testid="case-detail">
              <p style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>{c.description}</p>
              <p style={{ fontSize: 11, color: '#3f565c', margin: '0 0 8px' }}>
                <Tag tone={c.priority === 'URGENT' ? 'bad' : c.priority === 'HIGH' ? 'warn' : 'ok'}>{c.priority}</Tag>{' '}<Tag tone={c.status === 'CLOSED' || c.status === 'RESOLVED' ? 'ok' : c.status === 'IN_PROGRESS' ? 'warn' : 'bad'}>{c.status.split('_').join(' ')}</Tag>
                {c.booking ? <> · Booking <Link href={`/bookings/${c.booking.id}`}>{c.booking.reference}</Link></> : null}{c.hotel ? <> · Hotel <Link href={`/hotels/${c.hotel.id}`}>{c.hotel.name}</Link></> : null}
                {c.supplier ? <> · Supplier {c.supplier.name}</> : null}{c.agency ? <> · Agency {c.agency.name}</> : null}
              </p>
              {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="case-notice" style={{ margin: '8px 0' }}>{notice.text}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                {c.allowedTransitions.map((to) => <button key={to} type="button" className="admin-btn" disabled={busy} onClick={() => void act(async () => { await transitionCase(c.id, { to }); return `Case moved to ${to.split('_').join(' ')}.` })}>{verb[to] ?? to}</button>)}
                {c.status !== 'CLOSED' && (
                  <label style={lab}>Assigned to
                    <select style={field} value={c.assignee?.id ?? ''} disabled={busy} onChange={(e) => void act(async () => { await assignCase(c.id, { assigneeId: e.target.value || null }); return 'Assignment updated.' })}>
                      <option value="">Unassigned</option>{assignees.state.status === 'ready' && assignees.state.data.map((a) => <option key={a.id} value={a.id}>{a.name ?? a.email}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </section>
            <section className="workspace-panel" style={{ padding: '12px 18px' }} aria-labelledby="notes-h" data-testid="case-notes">
              <h2 id="notes-h" style={{ fontSize: 14 }}>Notes</h2>
              {c.notes.length === 0 ? <p style={{ color: '#3f565c' }}>No notes yet.</p> : <ol style={{ paddingLeft: 18 }}>{c.notes.map((n) => <li key={n.id} style={{ marginBottom: 6 }}><div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div><div style={{ fontSize: 10, color: '#3f565c' }}>{n.authorEmail} · {when(n.createdAt)}</div></li>)}</ol>}
              {c.status !== 'CLOSED' ? (
                <form onSubmit={(e) => { e.preventDefault(); const text = note; void act(async () => { await addCaseNote(c.id, text); setNote(''); return 'Note added.' }) }} style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                  <label style={lab}>Add a note (notes cannot be edited or removed)<textarea style={{ ...field, minHeight: 60 }} value={note} onChange={(e) => setNote(e.target.value)} required maxLength={2000} /></label>
                  <div><button type="submit" className="admin-btn" disabled={busy || !note.trim()}>Add note</button></div>
                </form>
              ) : <p style={{ color: '#3f565c', fontSize: 11 }}>A closed case takes no more notes.</p>}
            </section>
          </>
        )}
      </OpsState>
    </div>
  )
}
