'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, HelpCircle, RotateCcw, Save, Undo2, X } from 'lucide-react'
import type { RoomSalesCalendar, RoomSalesCell, RoomSalesMode, RoomSalesPreview, SalesHistoryEntry } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { checkSalesEligibility, commitSales, deliverSalesDistribution, getSalesCalendar, getSalesHistory, previewSales } from '@/lib/data/room-sales'
import { clearPaintMode, emptyPaint, fillRange, paintBlockedReason, paintStroke, resetPaint, undoPaint, beginStroke, type PaintDraft, type PaintMode } from '@/lib/room-sales-paint'

const MODES: Array<{ id: PaintMode; label: string; hint: string }> = [
  { id: 'FREE_SALE', label: 'Free Sale', hint: 'Allows instant confirmation only when inventory, rates and restrictions still pass. It does not create unlimited stock.' },
  { id: 'STOP_SALE', label: 'Stop Sale', hint: 'Blocks new sales. Existing bookings stay.' },
  { id: 'ON_REQUEST', label: 'On Request', hint: 'Opens a supplier request. It is never an instant confirmation.' },
  { id: 'LIMITED', label: 'Limited', hint: 'Sells only up to the cap you enter for each stay night.' },
]
const ICONS = { FREE_SALE: Check, STOP_SALE: X, ON_REQUEST: HelpCircle, LIMITED: AlertTriangle }
const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

export function RoomAvailabilityPanel({ hotelId }: { hotelId: string }) {
  const [days, setDays] = useState(28)
  const [from, setFrom] = useState('')
  const [poolId, setPoolId] = useState('')
  const [contractId, setContractId] = useState('')
  const [ratePlanId, setRatePlanId] = useState('')
  const [channel, setChannel] = useState('')
  const [market, setMarket] = useState('')
  const query = useMemo(() => ({ from: from || undefined, days, poolId: poolId || undefined, contractId: contractId || undefined, ratePlanId: ratePlanId || undefined, channel: channel || undefined, market: market || undefined }), [from, days, poolId, contractId, ratePlanId, channel, market])
  const { state, reload, refresh } = useOpsQuery(() => getSalesCalendar(hotelId, query), [hotelId, query.from, query.days, query.poolId, query.contractId, query.ratePlanId, query.channel, query.market])
  return (
    <section className="room-sales" aria-label="Room availability">
      <OpsState state={state} onRetry={reload} isEmpty={(data) => data.rooms.length === 0} empty={{ title: 'No room types', description: 'This hotel has no active room type, so there is no availability calendar.' }}>
        {(data) => <Calendar hotelId={hotelId} data={data} days={days} setDays={setDays} from={from} setFrom={setFrom} poolId={poolId} setPoolId={setPoolId} contractId={contractId} setContractId={setContractId} ratePlanId={ratePlanId} setRatePlanId={setRatePlanId} channel={channel} setChannel={setChannel} market={market} setMarket={setMarket} onSaved={refresh} />}
      </OpsState>
    </section>
  )
}

function Calendar(props: {
  hotelId: string; data: RoomSalesCalendar; days: number; setDays: (n: number) => void; from: string; setFrom: (v: string) => void
  poolId: string; setPoolId: (v: string) => void; contractId: string; setContractId: (v: string) => void; ratePlanId: string; setRatePlanId: (v: string) => void
  channel: string; setChannel: (v: string) => void; market: string; setMarket: (v: string) => void; onSaved: () => void
}) {
  const canManage = useCan()('supply.availability.manage')
  const [draft, setDraft] = useState<PaintDraft>(() => emptyPaint(props.data.window.from, props.data.window.to))
  const [selected, setSelected] = useState<RoomSalesCell | null>(null)
  const [history, setHistory] = useState<SalesHistoryEntry[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [preview, setPreview] = useState<RoomSalesPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const stroke = useRef<Set<string> | null>(null)
  const dirty = draft.cells.length > 0
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (!dirty) return; event.preventDefault(); event.returnValue = '' }
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest('a')
      if (!dirty || !anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (!window.confirm('You have unsaved availability changes. Leave this page and discard them?')) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', warn)
    document.addEventListener('click', click, true)
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', click, true) }
  }, [dirty])
  const cellAt = (roomTypeId: string, stayDate: string) => props.data.cells.find((cell) => cell.roomTypeId === roomTypeId && cell.stayDate === stayDate)
  const painted = (roomTypeId: string, stayDate: string) => draft.cells.find((cell) => cell.roomTypeId === roomTypeId && cell.stayDate === stayDate)
  function paintAt(roomTypeId: string, stayDate: string) {
    const saved = cellAt(roomTypeId, stayDate)
    if (!stroke.current || !saved) return
    setDraft((current) => paintStroke(current, [{ roomTypeId, stayDate, version: saved.version }], stroke.current!))
  }
  async function openSave() {
    setError(null); setPreview(null)
    const blocked = paintBlockedReason(draft)
    if (blocked || !draft.mode) { setError(blocked ?? 'Choose a paint mode.'); return }
    try {
      const result = await previewSales(props.hotelId, bodyOf(draft, props.data))
      setPreview(result)
    } catch (cause) { setError(apiErrorParts(cause, 'preview the change').message); setPreview(null) }
  }
  async function save() {
    if (!preview?.canSave || !draft.mode || saving) return
    setSaving(true); setError(null)
    try {
      const result = (await commitSales(props.hotelId, { ...bodyOf(draft, props.data), expectedFingerprint: preview.fingerprint, idempotencyKey: crypto.randomUUID() })).data
      setNotice(`${result.replayed ? 'This save was already recorded.' : 'Saved.'} Distribution is ${result.distribution.state}. ${result.distribution.label}`)
      setPreview(null); setDraft(resetPaint(draft)); props.onSaved()
    } catch (cause) { setError(`${apiErrorParts(cause, 'save the change').message} The draft is still here.`) }
    finally { setSaving(false) }
  }
  async function choose(cell: RoomSalesCell) {
    setSelected(cell); setHistory(null); setHistoryError(null)
    try { setHistory(await getSalesHistory(props.hotelId, { roomTypeId: cell.roomTypeId, stayDate: cell.stayDate })) }
    catch (cause) { setHistoryError(apiErrorParts(cause, 'load the history').message) }
  }
  const blocked = paintBlockedReason(draft)
  return (
    <div className="room-sales-board">
      <header className="room-sales-heading">
        <div>
          <h2>Room Availability Calendar</h2>
          <p>{props.data.hotelName} · hotel time {props.data.timeZone} · today {props.data.hotelToday}. {props.data.scopeLabel}</p>
        </div>
        <p className="room-sales-note">{props.data.notes[0]}</p>
      </header>
      <div className="room-sales-filters">
        <label>Contract<select value={props.contractId} onChange={(event) => props.setContractId(event.target.value)}><option value="">All contracts</option>{props.data.contracts.map((contract) => <option key={contract.id} value={contract.id}>{contract.code} · {contract.supplierName}</option>)}</select></label>
        <label>Inventory pool<select value={props.poolId} onChange={(event) => props.setPoolId(event.target.value)}><option value="">All pools</option>{props.data.pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select></label>
        <label>Rate plan<select value={props.ratePlanId} onChange={(event) => props.setRatePlanId(event.target.value)}><option value="">All rate plans</option>{props.data.ratePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.roomName} · {plan.code} · {plan.boardCode}</option>)}</select></label>
        <label>Channel<select value={props.channel} onChange={(event) => props.setChannel(event.target.value)}><option value="">All channels</option>{props.data.channels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Market<select value={props.market} onChange={(event) => props.setMarket(event.target.value)}><option value="">All markets</option>{props.data.markets.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      </div>
      <div className="room-sales-toolbar" role="toolbar" aria-label="Paint mode">
        {MODES.map((mode) => { const Icon = ICONS[mode.id]; return <button key={mode.id} type="button" className={`paint paint-${mode.id}${draft.mode === mode.id ? ' is-selected' : ''}`} aria-pressed={draft.mode === mode.id} title={mode.hint} disabled={!canManage} onClick={() => setDraft({ ...draft, mode: mode.id })}><Icon aria-hidden="true" size={16} />{mode.label}</button> })}
        <button type="button" onClick={() => setDraft(clearPaintMode(draft))}>Clear Paint Mode</button>
        <button type="button" onClick={() => setDraft(undoPaint(draft))} disabled={draft.undo.length === 0}><Undo2 aria-hidden="true" size={14} />Undo</button>
        <button type="button" onClick={() => { if (dirty && window.confirm('Discard unsaved availability changes?')) setDraft(resetPaint(draft)) }}><RotateCcw aria-hidden="true" size={14} />Reset Unsaved Changes</button>
        <button type="button" className="paint-save" disabled={!canManage || !dirty} onClick={openSave}><Save aria-hidden="true" size={14} />Save Changes</button>
      </div>
      {draft.mode === 'LIMITED' && <label className="room-sales-setting">Sales cap per stay night<input inputMode="numeric" value={draft.salesCap} onChange={(event) => setDraft({ ...draft, salesCap: event.target.value })} /></label>}
      {draft.mode === 'ON_REQUEST' && <div className="room-sales-settings"><label>Response deadline hours<input inputMode="numeric" value={draft.deadlineHours} onChange={(event) => setDraft({ ...draft, deadlineHours: event.target.value })} /></label><label>Owner<input value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} /></label><label>Escalation<input value={draft.escalation} onChange={(event) => setDraft({ ...draft, escalation: event.target.value })} /></label></div>}
      {blocked && draft.mode && <p className="room-sales-warn" role="status">{blocked}</p>}
      <div className="room-sales-bulk">
        <h3>Stay dates and rooms</h3>
        <label>Stay date from<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>Stay date to<input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
        <label className="room-sales-check"><input type="checkbox" checked={draft.allRoomTypes} onChange={(event) => setDraft({ ...draft, allRoomTypes: event.target.checked })} />All room types</label>
        {!draft.allRoomTypes && <div className="room-sales-rooms">{props.data.rooms.map((room) => <label key={room.id}><input type="checkbox" checked={draft.roomTypeIds.includes(room.id)} onChange={(event) => setDraft({ ...draft, roomTypeIds: event.target.checked ? [...draft.roomTypeIds, room.id] : draft.roomTypeIds.filter((id) => id !== room.id) })} />{room.name}</label>)}</div>}
        <div className="room-sales-rooms">{WEEKDAYS.map((day) => <label key={day}><input type="checkbox" checked={draft.weekdays.includes(day)} onChange={(event) => setDraft({ ...draft, weekdays: event.target.checked ? [...draft.weekdays, day] : draft.weekdays.filter((item) => item !== day) })} />{day}</label>)}</div>
        <button type="button" disabled={!canManage} onClick={() => { const filled = fillRange(draft, props.data.rooms, props.data.cells.map((cell) => ({ roomTypeId: cell.roomTypeId, stayDate: cell.stayDate, version: cell.version }))); setDraft(filled.draft); setError(filled.error) }}>Fill Range</button>
      </div>
      <div className="room-sales-nav">
        <button type="button" onClick={() => props.setFrom(shift(props.data.window.from, -props.days))}>Previous</button>
        <button type="button" onClick={() => props.setFrom(props.data.hotelToday)}>Today</button>
        <button type="button" onClick={() => props.setFrom(shift(props.data.window.from, props.days))}>Next</button>
        <label>Days to show<select value={props.days} onChange={(event) => props.setDays(Number(event.target.value))}><option value={7}>7 Days</option><option value={14}>14 Days</option><option value={28}>28 Days</option></select></label>
        <p>{props.data.window.from} – {props.data.window.to}</p>
        <p className="room-sales-count" role="status">{dirty ? `${draft.cells.length} unsaved cell${draft.cells.length === 1 ? '' : 's'}` : 'No unsaved changes'}</p>
      </div>
      <div className="status-legend" aria-label="Status legend"><span><Check aria-hidden="true" size={14} />Free Sale</span><span><X aria-hidden="true" size={14} />Stop Sale</span><span><HelpCircle aria-hidden="true" size={14} />On Request</span><span><AlertTriangle aria-hidden="true" size={14} />Limited</span><span>Not configured</span></div>
      <div className="room-sales-scroll">
        <table className="room-sales-grid">
          <thead><tr><th className="room-sales-sticky">Room type</th>{props.data.dates.map((date) => <th key={date}>{date.slice(8)}<small>{date.slice(5, 7)}</small></th>)}</tr></thead>
          <tbody>
            {props.data.rooms.map((room) => <tr key={room.id}><th className="room-sales-sticky">{room.name}<small>Max {room.maxOccupancy} guests</small></th>{props.data.dates.map((date) => {
              const saved = cellAt(room.id, date); const draftCell = painted(room.id, date); const mode = draftCell?.mode ?? saved?.configuredMode ?? null
              const outcome = saved?.effectiveOutcome ?? 'NOT_CONFIGURED'
              return <td key={date}><button type="button" className={`sales-cell sales-${mode ?? 'none'}${draftCell ? ' is-dirty' : ''}`} aria-label={`${room.name} ${date}. Configured ${labelOf(mode)}. Effective ${outcome.split('_').join(' ')}.`} onPointerDown={(event) => { stroke.current = beginStroke(); event.currentTarget.setPointerCapture(event.pointerId); paintAt(room.id, date); if (saved) void choose(saved) }} onPointerEnter={() => { if (stroke.current) paintAt(room.id, date) }} onPointerUp={() => { stroke.current = null }}>{mode ? <ModeMark mode={mode} cap={draftCell?.salesCap ?? saved?.salesCap ?? null} /> : <span>Not set</span>}</button></td>
            })}</tr>)}
          </tbody>
        </table>
      </div>
      {selected && <CellDetails cell={selected} roomName={props.data.rooms.find((room) => room.id === selected.roomTypeId)?.name ?? 'Room'} history={history} historyError={historyError} />}
      <Distribution jobs={props.data.jobs} hotelId={props.hotelId} canManage={canManage} onDone={props.onSaved} />
      <Eligibility hotelId={props.hotelId} plans={props.data.ratePlans} />
      {error && <p className="room-sales-warn" role="alert">{error}</p>}
      {notice && <p className="room-sales-note" role="status">{notice}</p>}
      {preview && <SaveDialog preview={preview} reason={draft.reason} setReason={(reason) => setDraft({ ...draft, reason })} confirm={draft.confirmBroadReopen} setConfirm={(confirmBroadReopen) => setDraft({ ...draft, confirmBroadReopen })} saving={saving} onClose={() => setPreview(null)} onSave={save} />}
    </div>
  )
}

function bodyOf(draft: PaintDraft, data: RoomSalesCalendar) {
  return {
    poolId: data.scope.poolId, ratePlanId: data.scope.ratePlanId, channel: data.scope.channel, market: data.scope.market, contractId: data.scope.contractId,
    mode: draft.mode!, salesCap: draft.mode === 'LIMITED' ? Number(draft.salesCap) : null, responseDeadlineHours: draft.mode === 'ON_REQUEST' ? Number(draft.deadlineHours) : null,
    requestOwnerLabel: draft.owner, escalationPolicy: draft.escalation, roomTypeIds: draft.roomTypeIds, allRoomTypes: draft.allRoomTypes, from: draft.from, to: draft.to,
    weekdays: draft.weekdays, reason: draft.reason, confirmBroadReopen: draft.confirmBroadReopen, cells: draft.cells.map((cell) => ({ roomTypeId: cell.roomTypeId, stayDate: cell.stayDate, expectedVersion: cell.version })),
  }
}
function labelOf(mode: RoomSalesMode | null) { return MODES.find((item) => item.id === mode)?.label ?? 'Not configured' }
function shift(date: string, days: number) { return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10) }
function ModeMark({ mode, cap }: { mode: RoomSalesMode; cap: number | null }) {
  const Icon = ICONS[mode]
  return <span><Icon aria-hidden="true" size={14} />{labelOf(mode)}{mode === 'LIMITED' && cap !== null ? ` ${cap}` : ''}</span>
}
function CellDetails({ cell, roomName, history, historyError }: { cell: RoomSalesCell; roomName: string; history: SalesHistoryEntry[] | null; historyError: string | null }) {
  const stock = cell.inventory
  return <aside className="room-sales-details" aria-label="Cell details"><h3>{roomName} · {cell.stayDate}</h3><dl>
    <div><dt>Configured mode</dt><dd>{labelOf(cell.configuredMode)}</dd></div>
    <div><dt>Effective outcome</dt><dd>{cell.effectiveOutcome.split('_').join(' ')}</dd></div>
    <div><dt>Inventory remaining</dt><dd>{stock?.remaining ?? 'Unknown'}</dd></div>
    <div><dt>Cap remaining</dt><dd>{cell.capRemaining ?? 'No cap'}</dd></div>
    <div><dt>Scope</dt><dd>{cell.scopeLabel}</dd></div>
    <div><dt>Source</dt><dd>{cell.source ?? 'None'}</dd></div>
    <div><dt>Last update</dt><dd>{cell.actorName ? `${cell.actorName}, ${cell.updatedAt ?? ''}` : 'No saved rule'}</dd></div>
    <div><dt>Distribution</dt><dd>{cell.distributionState ?? 'Not queued'}</dd></div>
  </dl>{cell.effectiveReasons.map((reason) => <p key={reason}>{reason}</p>)}{stock && <p>Pool {stock.poolName}. Contracted {stock.contracted ?? 'unknown'}, adjustment {stock.approvedAdjustment ?? 'unknown'}, confirmed {stock.confirmed ?? 'unknown'}, holds {stock.activeHolds ?? 'unknown'}, blocked {stock.blocked ?? 'unknown'}. Release {stock.releaseCutoff ?? 'not set'}. After release {stock.postReleasePolicy ?? 'not set'}.</p>}
    <h4>Audit history</h4>{historyError && <p role="alert">{historyError}</p>}{history && history.length === 0 && <p>No saved changes for this cell.</p>}{history?.map((entry) => <p key={entry.at}>{entry.at} · {entry.actorName} · {entry.source} · {entry.beforeMode ?? 'none'} to {entry.afterMode ?? 'none'} · {entry.reason}</p>)}</aside>
}
function Distribution({ jobs, hotelId, canManage, onDone }: { jobs: RoomSalesCalendar['jobs']; hotelId: string; canManage: boolean; onDone: () => void }) {
  const [message, setMessage] = useState<string | null>(null)
  return <section aria-label="Distribution"><h3>Distribution</h3><p>A saved change stays pending until this simulated adapter acknowledges it. There is no live supplier connection.</p>{jobs.length === 0 && <p>No distribution jobs.</p>}{jobs.map((job) => <p key={job.id}>{job.state} · attempt {job.attempts} · {job.label}{job.lastError ? ` · ${job.lastError}` : ''} {canManage && job.state !== 'ACKNOWLEDGED' && <button type="button" onClick={async () => { try { const result = await deliverSalesDistribution(hotelId, job.id); setMessage(result.note); onDone() } catch (cause) { setMessage(apiErrorParts(cause, 'deliver the simulated update').message) } }}>Retry simulated delivery</button>}</p>)}{message && <p role="status">{message}</p>}</section>
}
function Eligibility({ hotelId, plans }: { hotelId: string; plans: RoomSalesCalendar['ratePlans'] }) {
  const [ratePlanId, setRatePlanId] = useState(plans[0]?.id ?? '')
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [rooms, setRooms] = useState('1')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return <section aria-label="Booking eligibility"><h3>Check a stay</h3><p>Check-in is included and check-out is excluded. This does not reserve a room.</p>
    <label>Rate plan<select value={ratePlanId} onChange={(event) => setRatePlanId(event.target.value)}>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.code}</option>)}</select></label>
    <label>Check-in<input type="date" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} /></label>
    <label>Check-out<input type="date" value={checkOut} onChange={(event) => setCheckOut(event.target.value)} /></label>
    <label>Rooms<input inputMode="numeric" value={rooms} onChange={(event) => setRooms(event.target.value)} /></label>
    <button type="button" onClick={async () => { setError(null); setResult(null); try { const decision = await checkSalesEligibility(hotelId, { ratePlanId, checkIn, checkOut, rooms: Number(rooms), adults: 2, children: 0 }); setResult(`${decision.outcome}. ${decision.note} ${decision.reasons.join(' ')}`) } catch (cause) { setError(apiErrorParts(cause, 'check the stay').message) } }}>Check eligibility</button>
    {result && <p role="status">{result}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
function SaveDialog({ preview, reason, setReason, confirm, setConfirm, saving, onClose, onSave }: { preview: RoomSalesPreview; reason: string; setReason: (v: string) => void; confirm: boolean; setConfirm: (v: boolean) => void; saving: boolean; onClose: () => void; onSave: () => void }) {
  return <div className="room-sales-dialog" role="dialog" aria-modal="true" aria-label="Review availability changes"><h3>Review before saving</h3>
    <p>{preview.scopeLabel}. {preview.roomTypeIds.length} room types. {preview.from} to {preview.to}, inclusive. {preview.affected} cells.</p>
    <ul>{preview.changes.slice(0, 12).map((change) => <li key={`${change.roomTypeId}-${change.stayDate}`}>{change.roomName} {change.stayDate}: {change.fromMode ?? 'none'} → {change.toMode}</li>)}</ul>
    {preview.errors.length > 0 && <ul>{preview.errors.map((item) => <li key={item}>{item}</li>)}</ul>}
    <p>{preview.distributionNote}</p>
    <label>Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    <label><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />I am reopening a room-wide Stop Sale and I have hotel management authority.</label>
    <button type="button" onClick={onClose}>Keep editing</button>
    <button type="button" disabled={!preview.canSave || saving || reason.trim().length < 3} onClick={onSave}>{saving ? 'Saving' : 'Save the whole batch'}</button>
  </div>
}
