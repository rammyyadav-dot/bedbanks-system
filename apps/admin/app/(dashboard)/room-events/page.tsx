'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { ROOM_EVENT_STATUSES, ROOM_EVENT_TYPES, type RoomEventRead } from '@bedbanks/contracts'
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { Pager } from '@/components/ops/Pager'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { cancelRoomEvent, cancelRoomEventApproval, createRoomEvent, decideRoomEventApproval, getRoomEvents } from '@/lib/data/room-events'
import { describeApiError } from '@/lib/api/describe-error'

const PAGE_SIZE = 25
const statusTone = (s: RoomEventRead['status']) => (s === 'APPROVED' ? 'ok' : s === 'CANCELLED' ? 'bad' : s === 'ARCHIVED' ? 'neutral' : 'warn') as 'ok' | 'bad' | 'warn' | 'neutral'

/**
 * Room Event Master (ADR 0089): the event catalogue — exhibitions, trade fairs, festivals, peak-demand periods — independent of any
 * hotel's commercial terms. An event must be APPROVED (a second person's review) before any event supplement may reference it. Open an
 * event to manage its supplements.
 */
export default function RoomEventsPage() {
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1)
  const { state, reload } = useOpsQuery(() => getRoomEvents({ status: status || undefined, page, pageSize: PAGE_SIZE }), [status, page])
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
      <PageHeader eyebrow="CONTRACTING" title="Room Event Master" description="Exhibitions, trade fairs and peak-demand periods that may carry mandatory event supplements. An event is approved here before any hotel-specific supplement can reference it; the supplement itself, its dates and its amount are configured on the event's own page." />
      <CreateRoomEvent onCreated={(text) => { setNotice({ tone: 'ok', text }); reload() }} />
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} data-testid="room-event-notice" style={{ margin: '8px 0' }}>{notice.text}</div>}
      <form aria-label="Room event filters" onSubmit={(e) => e.preventDefault()} style={{ display: 'flex', gap: 12, margin: '8px 0', color: 'var(--c-444444)', fontSize: 11 }}>
        <label style={{ display: 'grid', gap: 2, color: 'var(--c-444444)' }}>Status<select style={{ color: 'var(--c-111111)' }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">All</option>{ROOM_EVENT_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></label>
      </form>
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No room events', description: 'No event matches. Create one to start configuring event supplements.' }}>
        {(d) => (
          <div className="workspace-panel" data-testid="room-events-table">
            <ScrollRegion label="Room events">
              <table style={tableStyle} aria-label="Room events">
                <thead><tr>{['Event', 'Destination', 'Event dates', 'Status', 'Reference', 'Approval', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{d.items.map((r) => (
                  <tr key={r.id} data-testid={`room-event-${r.status.toLowerCase()}`}>
                    <td style={td}><Link href={`/room-events/${r.id}`}><strong>{r.name}</strong></Link><div style={{ fontSize: 10, color: 'var(--c-444444)' }}>{r.eventType}</div></td>
                    <td style={td}>{r.destinationCity}, {r.destinationCountry}</td>
                    <td style={td}>{r.eventStartDate} → {r.eventEndDate}</td>
                    <td style={td}><Tag tone={statusTone(r.status)}>{r.status}</Tag>{r.approvedAt ? <div style={{ fontSize: 10 }}>approved {when(r.approvedAt)}</div> : null}</td>
                    <td style={td}>{r.referenceRef ?? '—'}</td>
                    <td style={td}>{r.approval ? <>{r.approval.status}{r.approval.decisionReason ? <div style={{ fontSize: 10 }}>{r.approval.decisionReason}</div> : null}</> : '—'}</td>
                    <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <Link href={`/room-events/${r.id}`} className="admin-btn">Open</Link>
                      {(r.status === 'DRAFT' || r.status === 'PENDING_APPROVAL') && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('cancel'); if (reason) void act(`c-${r.id}`, async () => { await cancelRoomEvent(r.id, { reason }); return 'Event cancelled.' }) }}>Cancel</button>}
                      {r.approval?.canDecide && <>
                        <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('approve'); if (reason) void act(`a-${r.id}`, async () => { await decideRoomEventApproval(r.approval!.id, 'approve', reason); return 'Approved.' }) }}>Approve</button>
                        <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('reject'); if (reason) void act(`r-${r.id}`, async () => { await decideRoomEventApproval(r.approval!.id, 'reject', reason); return 'Rejected; the event returns to DRAFT.' }) }}>Reject</button>
                      </>}
                      {r.approval?.canCancel && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`cr-${r.id}`, async () => { await cancelRoomEventApproval(r.approval!.id); return 'Request cancelled.' })}>Cancel request</button>}
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

function CreateRoomEvent({ onCreated }: { onCreated: (text: string) => void }) {
  const [name, setName] = useState(''); const [eventType, setEventType] = useState<typeof ROOM_EVENT_TYPES[number]>('EXHIBITION')
  const [destinationCity, setCity] = useState(''); const [destinationCountry, setCountry] = useState('')
  const [eventStartDate, setStart] = useState(''); const [eventEndDate, setEnd] = useState('')
  const [referenceRef, setReference] = useState(''); const [internalNotes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      await createRoomEvent({ name, eventType, destinationCity, destinationCountry: destinationCountry.toUpperCase(), eventStartDate, eventEndDate, referenceRef: referenceRef || null, internalNotes: internalNotes || null })
      setName(''); setCity(''); setCountry(''); setStart(''); setEnd(''); setReference(''); setNotes('')
      onCreated('Draft event created. It changes no price until it is approved and a supplement references it.')
    } catch (e) { setError(describeApiError(e, 'create the event')) } finally { setBusy(false) }
  }
  const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-444444)' } as const
  const field = { color: 'var(--c-111111)' } as const
  return (
    <form onSubmit={submit} aria-label="New room event" className="workspace-panel" style={{ padding: '12px 18px', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }} data-testid="room-event-form">
      <label style={lab}>Name<input style={{ ...field, minWidth: 180 }} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} required /></label>
      <label style={lab}>Type<select style={field} value={eventType} onChange={(e) => setEventType(e.target.value as typeof eventType)}>{ROOM_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      <label style={lab}>City<input style={{ ...field, width: 120 }} value={destinationCity} onChange={(e) => setCity(e.target.value)} maxLength={120} required /></label>
      <label style={lab} title="ISO 3166-1 alpha-2">Country<input style={{ ...field, width: 50 }} value={destinationCountry} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} required /></label>
      <label style={lab}>Event start<input style={field} type="date" value={eventStartDate} onChange={(e) => setStart(e.target.value)} required /></label>
      <label style={lab}>Event end<input style={field} type="date" value={eventEndDate} onChange={(e) => setEnd(e.target.value)} required /></label>
      <label style={lab} title="Supplier notice or contract amendment reference">Reference<input style={{ ...field, width: 160 }} value={referenceRef} onChange={(e) => setReference(e.target.value)} maxLength={200} /></label>
      <label style={{ ...lab, flexBasis: '100%' }}>Internal notes<textarea style={{ ...field, width: '100%' }} rows={2} value={internalNotes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} /></label>
      <button type="submit" className="admin-btn" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button>
      {error && <div className="admin-error" role="alert" style={{ flexBasis: '100%' }}>{error}</div>}
    </form>
  )
}
