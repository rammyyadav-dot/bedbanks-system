'use client'

import { use, useRef, useState } from 'react'
import Link from 'next/link'
import { type EventSupplementAmountKind, type EventSupplementRead } from '@bedbanks/contracts'

const SUPPLEMENT_BASES = ['PER_ADULT', 'PER_CHILD', 'PER_PERSON', 'PER_ROOM'] as const
const SUPPLEMENT_FREQUENCIES = ['PER_NIGHT', 'PER_STAY'] as const
import { PageHeader } from '@/components/common/PageHeader'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { Money, Tag, when } from '@/components/ops/ops-ui'
import { ScrollRegion, td, th, tableStyle } from '@/components/hotels/ui'
import { describeApiError } from '@/lib/api/describe-error'
import {
  activateEventSupplement, archiveRoomEvent, cancelEventSupplementApproval, cancelRoomEvent, cancelRoomEventApproval, createEventSupplement,
  decideEventSupplementApproval, decideRoomEventApproval, executeEventSupplementApproval, getEventSupplements, getRoomEvent, previewEventSupplements,
  requestEventSupplementAmendment, submitEventSupplement, submitRoomEvent, suspendEventSupplement, type EventSupplementView,
} from '@/lib/data/room-events'

const roomEventTone = (s: string) => (s === 'APPROVED' ? 'ok' : s === 'CANCELLED' ? 'bad' : s === 'ARCHIVED' ? 'neutral' : 'warn') as 'ok' | 'bad' | 'warn' | 'neutral'
const supplementTone = (s: string) => (s === 'ACTIVE' ? 'ok' : s === 'SUSPENDED' || s === 'EXPIRED' ? 'bad' : s === 'APPROVED' ? 'neutral' : 'warn') as 'ok' | 'bad' | 'warn' | 'neutral'

/**
 * One Room Event and the event/exhibition supplements that reference it (ADR 0089). A supplement names this page's event, one contract
 * and optionally one rate plan; it prices on top of the contract's DailyRate, never in place of it. Nothing here computes a sell price:
 * the Rate Impact Preview panel calls the API's own preview endpoint.
 */
export default function RoomEventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { state, reload } = useOpsQuery(() => getRoomEvent(id), [id])
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
      <PageHeader eyebrow="CONTRACTING" title="Room event" description="Event details, its approval lifecycle, and the event supplements that reference it." actions={<Link href="/room-events" className="admin-btn">Back to Room Event Master</Link>} />
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'} style={{ margin: '8px 0' }}>{notice.text}</div>}
      <OpsState state={state} onRetry={reload}>
        {(event) => (
          <>
            <div className="workspace-panel" style={{ padding: '14px 18px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'start' }}>
              <div>
                <h2 style={{ margin: '0 0 4px' }}>{event.name}</h2>
                <div style={{ fontSize: 12, color: 'var(--c-3f565c)' }}>{event.eventType} · {event.destinationCity}, {event.destinationCountry} · {event.eventStartDate} → {event.eventEndDate}</div>
                {event.referenceRef && <div style={{ fontSize: 11, color: 'var(--c-3f565c)' }}>Reference: {event.referenceRef}</div>}
                {event.internalNotes && <p style={{ fontSize: 12, maxWidth: 560 }}>{event.internalNotes}</p>}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Tag tone={roomEventTone(event.status)}>{event.status}</Tag>
                {event.approvedAt && <span style={{ fontSize: 11, color: 'var(--c-3f565c)' }}>approved {when(event.approvedAt)}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {event.status === 'DRAFT' && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('submit for approval'); if (reason) void act('submit', async () => { await submitRoomEvent(id, { reason }); return 'Submitted for approval.' }) }}>Submit for approval</button>}
                {(event.status === 'DRAFT' || event.status === 'PENDING_APPROVAL') && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('cancel'); if (reason) void act('cancel', async () => { await cancelRoomEvent(id, { reason }); return 'Event cancelled.' }) }}>Cancel</button>}
                {(event.status === 'APPROVED' || event.status === 'CANCELLED') && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('archive'); if (reason) void act('archive', async () => { await archiveRoomEvent(id, { reason }); return 'Event archived.' }) }}>Archive</button>}
                {event.approval?.canDecide && <>
                  <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('approve'); if (reason) void act('approve', async () => { await decideRoomEventApproval(event.approval!.id, 'approve', reason); return 'Approved.' }) }}>Approve</button>
                  <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('reject'); if (reason) void act('reject', async () => { await decideRoomEventApproval(event.approval!.id, 'reject', reason); return 'Rejected; the event returns to DRAFT.' }) }}>Reject</button>
                </>}
                {event.approval?.canCancel && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act('cancelreq', async () => { await cancelRoomEventApproval(event.approval!.id); return 'Request cancelled.' })}>Cancel request</button>}
              </div>
              {event.approval && <div style={{ fontSize: 11, color: 'var(--c-3f565c)', flexBasis: '100%' }}>Approval: {event.approval.status}{event.approval.decisionReason ? ` — ${event.approval.decisionReason}` : ''}</div>}
            </div>
            {event.status === 'APPROVED' ? <EventSupplements roomEventId={id} /> : (
              <div className="workspace-panel" style={{ padding: '14px 18px', color: 'var(--c-3f565c)' }}>Event supplements can be created once this event is APPROVED.</div>
            )}
          </>
        )}
      </OpsState>
    </div>
  )
}

function EventSupplements({ roomEventId }: { roomEventId: string }) {
  const { state, reload } = useOpsQuery(() => getEventSupplements({ roomEventId, pageSize: 50 }), [roomEventId])
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

  async function amendPrompt(s: EventSupplementRead): Promise<string> {
    const field = typeof window === 'undefined' ? '' : (window.prompt(s.amountKind === 'FIXED' ? 'New amountMinor (leave blank to keep)' : 'New percentBp (leave blank to keep)') ?? '').trim()
    const reason = ask('request this amendment')
    if (!reason) throw new Error('A reason is required')
    const changes = field ? (s.amountKind === 'FIXED' ? { amountMinor: field } : { percentBp: Number(field) }) : {}
    await requestEventSupplementAmendment(s.id, { changes, reason })
    return 'Amendment requested. A second person must approve it; Execute amendment then applies it.'
  }

  return (
    <div className="workspace-panel" style={{ padding: '14px 18px', display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>Event supplements</h3>
      <CreateEventSupplement roomEventId={roomEventId} onCreated={(text) => { setNotice({ tone: 'ok', text }); reload() }} />
      {notice && <div className={notice.tone === 'bad' ? 'admin-error' : 'workspace-panel'} role={notice.tone === 'bad' ? 'alert' : 'status'}>{notice.text}</div>}
      <OpsState state={state} onRetry={reload} isEmpty={(d) => d.items.length === 0} empty={{ title: 'No event supplements', description: 'No supplement references this event yet.' }}>
        {(d) => (
          <ScrollRegion label="Event supplements">
            <table style={tableStyle} aria-label="Event supplements">
              <thead><tr>{['Amount', 'Scope', 'Valid', 'Status', 'Version', 'Evidence', 'Approval', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
              <tbody>{d.items.map((s: EventSupplementView) => (
                <tr key={s.id} data-testid={`event-supplement-${s.status.toLowerCase()}`}>
                  <td style={td}>{s.amountKind === 'FIXED' ? <><Money minor={s.amountMinor} currency={s.currency} /> <span style={{ fontSize: 10, color: 'var(--c-3f565c)' }}>{s.basis} / {s.frequency}</span></> : <>{(s.percentBp! / 100).toFixed(2)}% of base</>}</td>
                  <td style={td}>{s.ratePlanId ? <span title={s.ratePlanId}>one rate plan</span> : 'hotel-wide (contract)'}{s.stackable ? <div style={{ fontSize: 10 }}>stackable, priority {s.priority}</div> : <div style={{ fontSize: 10 }}>exclusive, priority {s.priority}</div>}</td>
                  <td style={td}>{s.validFrom} → {s.validTo}</td>
                  <td style={td}><Tag tone={supplementTone(s.status)}>{s.status}</Tag></td>
                  <td style={td}>v{s.version}</td>
                  <td style={td}>{s.evidenceRef}</td>
                  <td style={td}>{s.approval ? <>{s.approval.status}{s.approval.decisionReason ? <div style={{ fontSize: 10 }}>{s.approval.decisionReason}</div> : null}</> : '—'}</td>
                  <td style={{ ...td, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {s.status === 'DRAFT' && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('submit'); if (reason) void act(`sub-${s.id}`, async () => { await submitEventSupplement(s.id, { reason }); return 'Submitted for approval.' }) }}>Submit</button>}
                    {s.status === 'APPROVED' && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('activate'); if (reason) void act(`act-${s.id}`, async () => { await activateEventSupplement(s.id, { reason }); return 'Activated. Search, the tariff calendar and checkout now price it.' }) }}>Activate</button>}
                    {s.status === 'ACTIVE' && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('suspend'); if (reason) void act(`sus-${s.id}`, async () => { await suspendEventSupplement(s.id, { reason }); return 'Suspended.' }) }}>Suspend</button>}
                    {(s.status === 'ACTIVE' || s.status === 'SUSPENDED') && !s.approval && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`amend-${s.id}`, () => amendPrompt(s))}>Request amendment</button>}
                    {s.approval?.canDecide && <>
                      <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('approve'); if (reason) void act(`appr-${s.id}`, async () => { await decideEventSupplementApproval(s.approval!.id, 'approve', reason); return 'Approved.' }) }}>Approve</button>
                      <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('reject'); if (reason) void act(`rej-${s.id}`, async () => { await decideEventSupplementApproval(s.approval!.id, 'reject', reason); return 'Rejected.' }) }}>Reject</button>
                    </>}
                    {s.approval?.canCancel && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => void act(`cr-${s.id}`, async () => { await cancelEventSupplementApproval(s.approval!.id); return 'Request cancelled.' })}>Cancel request</button>}
                    {s.approval?.canExecute && <button type="button" className="admin-btn" disabled={busy !== null} onClick={() => { const reason = ask('apply this amendment'); if (reason) void act(`exec-${s.id}`, async () => { await executeEventSupplementApproval(s.approval!.id, { reason }); return 'Amendment applied.' }) }}>Execute amendment</button>}
                  </td>
                </tr>))}</tbody>
            </table>
          </ScrollRegion>
        )}
      </OpsState>
      <RateImpactPreview roomEventSupplements={state.status === 'ready' ? state.data.items : []} />
    </div>
  )
}

function CreateEventSupplement({ roomEventId, onCreated }: { roomEventId: string; onCreated: (text: string) => void }) {
  const [contractId, setContractId] = useState(''); const [ratePlanId, setRatePlanId] = useState('')
  const [amountKind, setAmountKind] = useState<EventSupplementAmountKind>('FIXED')
  const [basis, setBasis] = useState<typeof SUPPLEMENT_BASES[number]>('PER_ROOM'); const [frequency, setFrequency] = useState<typeof SUPPLEMENT_FREQUENCIES[number]>('PER_NIGHT')
  const [amountMinor, setAmountMinor] = useState(''); const [percentBp, setPercentBp] = useState('')
  const [currency, setCurrency] = useState('AED'); const [validFrom, setValidFrom] = useState(''); const [validTo, setValidTo] = useState('')
  const [stackable, setStackable] = useState(false); const [priority, setPriority] = useState('0'); const [evidenceRef, setEvidenceRef] = useState('')
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      await createEventSupplement({
        roomEventId, contractId, ratePlanId: ratePlanId || null, currency, validFrom, validTo, stackable, priority: Number(priority) || 0, evidenceRef,
        ...(amountKind === 'FIXED' ? { amountKind: 'FIXED' as const, basis, frequency, amountMinor } : { amountKind: 'PERCENTAGE' as const, percentBp: Number(percentBp) }),
      })
      setContractId(''); setRatePlanId(''); setAmountMinor(''); setPercentBp(''); setValidFrom(''); setValidTo(''); setEvidenceRef('')
      onCreated('Draft supplement created. It prices nothing until it is submitted, approved and activated.')
    } catch (e) { setError(describeApiError(e, 'create the supplement')) } finally { setBusy(false) }
  }
  const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-3f565c)' } as const
  const field = { color: 'var(--c-17333e)' } as const
  return (
    <form onSubmit={submit} aria-label="New event supplement" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end', padding: '8px 0', borderBottom: '1px solid var(--c-e6eef0)' }}>
      <label style={lab}>Contract id<input style={{ ...field, minWidth: 180 }} value={contractId} onChange={(e) => setContractId(e.target.value)} required /></label>
      <label style={lab} title="Leave empty to apply to every plan of the contract">Rate plan id (optional)<input style={{ ...field, minWidth: 180 }} value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)} /></label>
      <label style={lab}>Amount kind<select style={field} value={amountKind} onChange={(e) => setAmountKind(e.target.value as EventSupplementAmountKind)}><option value="FIXED">Fixed</option><option value="PERCENTAGE">Percentage</option></select></label>
      {amountKind === 'FIXED' ? (
        <>
          <label style={lab}>Basis<select style={field} value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>{SUPPLEMENT_BASES.map((b) => <option key={b} value={b}>{b}</option>)}</select></label>
          <label style={lab}>Frequency<select style={field} value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>{SUPPLEMENT_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
          <label style={lab} title="Integer minor units">Amount (minor units)<input style={{ ...field, width: 100 }} inputMode="numeric" value={amountMinor} onChange={(e) => setAmountMinor(e.target.value)} required /></label>
        </>
      ) : (
        <label style={lab} title="Basis points of the night's own contracted base, e.g. 1000 = 10%">Percent (bp)<input style={{ ...field, width: 90 }} inputMode="numeric" value={percentBp} onChange={(e) => setPercentBp(e.target.value)} required /></label>
      )}
      <label style={lab}>Currency<input style={{ ...field, width: 60 }} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></label>
      <label style={lab}>Valid from<input style={field} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} required /></label>
      <label style={lab}>Valid to<input style={field} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} required /></label>
      <label style={lab} title="Among non-stackable eligible rules on the same night, the highest priority wins">Priority<input style={{ ...field, width: 60 }} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} /></label>
      <label style={{ ...lab, flexDirection: 'row', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={stackable} onChange={(e) => setStackable(e.target.checked)} />Stackable</label>
      <label style={lab} title="Supplier confirmation or authorized contract amendment reference">Evidence<input style={{ ...field, minWidth: 160 }} value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} maxLength={200} required /></label>
      <button type="submit" className="admin-btn" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button>
      {error && <div className="admin-error" role="alert" style={{ flexBasis: '100%' }}>{error}</div>}
    </form>
  )
}

/** Rate Impact Preview (spec section 7): calls the API's own preview endpoint — never computes a price in the browser. */
function RateImpactPreview({ roomEventSupplements }: { roomEventSupplements: EventSupplementRead[] }) {
  const defaultPlan = roomEventSupplements.find((s) => s.ratePlanId)?.ratePlanId ?? ''
  const [ratePlanId, setRatePlanId] = useState(defaultPlan)
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [rooms, setRooms] = useState('1'); const [adults, setAdults] = useState('2'); const [children, setChildren] = useState('0')
  const [result, setResult] = useState<Awaited<ReturnType<typeof previewEventSupplements>> | null>(null)
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false)

  function dates(): string[] {
    if (!from || !to) return []
    const out: string[] = []
    for (let d = new Date(`${from}T00:00:00.000Z`); d <= new Date(`${to}T00:00:00.000Z`); d = new Date(d.getTime() + 86_400_000)) out.push(d.toISOString().slice(0, 10))
    return out
  }
  async function run(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const stayDates = dates()
    if (!ratePlanId || stayDates.length === 0) { setError('Enter a rate plan id and a valid date range.'); return }
    setBusy(true); setError(null); setResult(null)
    try { setResult(await previewEventSupplements({ ratePlanId, stayDates, rooms: Number(rooms), adults: Number(adults), children: Number(children) })) }
    catch (e) { setError(describeApiError(e, 'load the preview')) } finally { setBusy(false) }
  }
  const lab = { display: 'grid', gap: 2, fontSize: 11, color: 'var(--c-3f565c)' } as const
  const field = { color: 'var(--c-17333e)' } as const
  return (
    <div style={{ borderTop: '1px solid var(--c-e6eef0)', paddingTop: 12 }}>
      <h4 style={{ margin: '0 0 8px' }}>Rate Impact Preview</h4>
      <form onSubmit={run} aria-label="Rate impact preview" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <label style={lab}>Rate plan id<input style={{ ...field, minWidth: 180 }} value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)} required /></label>
        <label style={lab}>From<input style={field} type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
        <label style={lab}>To<input style={field} type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>
        <label style={lab}>Rooms<input style={{ ...field, width: 50 }} inputMode="numeric" value={rooms} onChange={(e) => setRooms(e.target.value)} /></label>
        <label style={lab}>Adults<input style={{ ...field, width: 50 }} inputMode="numeric" value={adults} onChange={(e) => setAdults(e.target.value)} /></label>
        <label style={lab}>Children<input style={{ ...field, width: 50 }} inputMode="numeric" value={children} onChange={(e) => setChildren(e.target.value)} /></label>
        <button type="submit" className="admin-btn" disabled={busy}>{busy ? 'Loading…' : 'Preview'}</button>
      </form>
      {error && <div className="admin-error" role="alert" style={{ marginTop: 8 }}>{error}</div>}
      {result && (
        <table style={{ ...tableStyle, marginTop: 8 }} aria-label="Rate impact preview result">
          <thead><tr>{['Night', 'Contracted base', 'Event supplement', 'Adjusted net'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
          <tbody>{result.nights.map((n) => (
            <tr key={n.date}><td style={td}>{n.date}</td><td style={td}><Money minor={n.contractedBaseMinor} currency={result.currency} /></td><td style={td}><Money minor={n.eventSupplementMinor} currency={result.currency} /></td><td style={td}><strong><Money minor={n.adjustedNetMinor} currency={result.currency} /></strong></td></tr>
          ))}</tbody>
        </table>
      )}
      {result && result.eventSupplements.length > 0 && <div style={{ fontSize: 11, color: 'var(--c-3f565c)', marginTop: 4 }}>{result.eventSupplements.map((e) => `${e.roomEventName}: ${e.amountMinor} ${result.currency} minor (for the party entered)`).join('; ')}</div>}
    </div>
  )
}
