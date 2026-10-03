'use client'

import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { BED_TYPES, EXTRA_BED_SUPPORT, type BedType, type AmenitySelection, type ExtraBedSupport, type HotelCommercial360, type HotelRoomView, type HotelRoomsView, type RoomSave } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { formatMinorUnits } from '@/lib/minor-units'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { reasonText } from '@/lib/hotel-ui'
import { archiveHotelRoom, createHotelRoom, getHotelRooms, restoreHotelRoom, updateHotelRoom } from '@/lib/data/hotel-rooms'
import { AmenityPicker, amenityLabel, sameAmenities } from '../AmenityPicker'
import { Chip, InventoryChip, MappingChip, ReadinessChip, ScrollRegion, td, th, tableStyle } from '../ui'

type RoomForm = { name: string; code: string; maxAdults: string; maxChildren: string; maxOccupancy: string; description: string; beds: Record<BedType, string>; extraBed: ExtraBedSupport; amenities: AmenitySelection[] }
const emptyBeds = () => Object.fromEntries(BED_TYPES.map((t) => [t, ''])) as Record<BedType, string>
const toForm = (r?: HotelRoomView): RoomForm => {
  const beds = emptyBeds(); for (const b of r?.bedding.beds ?? []) beds[b.type] = String(b.count)
  return { name: r?.name ?? '', code: r?.code ?? '', maxAdults: String(r?.maxAdults ?? 2), maxChildren: String(r?.maxChildren ?? 0), maxOccupancy: String(r?.maxOccupancy ?? 2), description: r?.bedding.description ?? '', beds, extraBed: r?.bedding.extraBed ?? 'UNKNOWN', amenities: r?.amenities ?? [] }
}
const bedList = (beds: Record<BedType, string>) => BED_TYPES.filter((t) => beds[t] !== '' && Number(beds[t]) > 0).map((t) => ({ type: t, count: Number(beds[t]) }))
const field = { display: 'grid', gap: 2, fontSize: 12, color: '#17333e' } as const
const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const BED_LABEL: Record<BedType, string> = { SINGLE: 'Single', DOUBLE: 'Double', QUEEN: 'Queen', KING: 'King', TWIN: 'Twin', SOFA_BED: 'Sofa bed', BUNK: 'Bunk' }

/**
 * Canonical room master for one hotel. Management (create, edit, archive, restore) goes through the Admin room API with a
 * concurrency token and an idempotency key; commercial columns come from the API's own assessment. Rooms are never deleted.
 */
export function RoomsPanel({ data, onChanged }: { data: HotelCommercial360; onChanged: () => void }) {
  const hotelId = data.hotel.id
  const can = useCan()
  const canManage = can('supply.rooms.manage')
  const initial = useSearchParams().get('room')
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<string | null>(initial)
  const [flash, setFlash] = useState<string | null>(null)
  const { state, reload } = useOpsQuery(() => getHotelRooms(hotelId), [hotelId, version])
  const commercial = useMemo(() => new Map(data.rooms.map((r) => [r.id, r])), [data.rooms])
  const done = (text: string) => { setFlash(text); setEditing(null); setVersion((v) => v + 1); onChanged() }
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {flash && <div role="status" className="workspace-panel" data-testid="rooms-flash" style={{ padding: 12 }}><strong>{flash}</strong></div>}
      <OpsState state={state} onRetry={reload}>
        {(view) => (
          <>
            <div className="workspace-panel" style={{ padding: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h2 style={{ fontSize: 14, margin: 0 }}>Rooms ({view.rooms.length})</h2>
                {canManage && <button type="button" className="button primary" onClick={() => { setFlash(null); setEditing('new') }}>+ Add room</button>}
              </div>
              {!view.amenitiesAvailable && <p role="status" data-testid="amenities-unavailable" style={{ ...note, color: '#8a5a00' }}>Room amenities are unavailable to the API database role, so they are not shown or saved here.</p>}
              {view.rooms.length === 0 ? <p data-testid="rooms-empty" style={{ color: '#3f565c' }}>This hotel has no room types. Without a room, nothing can be mapped, priced or sold.</p> : (
                <ScrollRegion label="Rooms">
                  <table style={tableStyle} aria-label="Rooms">
                    <thead><tr>{['Room', 'Code', 'Occupancy', 'Bedding', 'Amenities', 'Status', 'Supplier mapping', 'Rate plans', 'Inventory', 'Sellability', 'Blockers', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {view.rooms.map((room) => {
                        const c = commercial.get(room.id)
                        return (
                          <tr key={room.id} data-room-id={room.id} data-active={room.isActive}>
                            <td style={td}><strong>{room.name}</strong><div style={{ fontSize: 10, color: '#3f565c' }}>Updated {when(room.updatedAt)}</div></td>
                            <td style={td}>{room.code}</td>
                            <td style={td}>{room.maxAdults} adults · {room.maxChildren} children · max {room.maxOccupancy}</td>
                            <td style={td}>{room.bedding.beds.length ? room.bedding.beds.map((b) => `${b.count} ${BED_LABEL[b.type]}`).join(', ') : room.bedding.description ?? '—'}<div style={{ fontSize: 10, color: '#3f565c' }}>Extra bed: {room.bedding.extraBed === 'SUPPORTED' ? 'supported' : room.bedding.extraBed === 'NOT_SUPPORTED' ? 'not supported' : 'not recorded'}</div></td>
                            <td style={td}>{room.amenities === null ? 'Unavailable' : room.amenities.length ? room.amenities.map((a) => amenityLabel(a.code)).join(', ') : 'None recorded'}</td>
                            <td style={td}><Chip tone={room.isActive ? 'ok' : 'neutral'}>{room.isActive ? 'ACTIVE' : 'ARCHIVED'}</Chip></td>
                            <td style={td}>{c ? <MappingChip value={c.mapping} /> : '—'}<div style={{ fontSize: 10, color: '#3f565c' }}>{room.usage.mappings.mapped} mapped · {room.usage.mappings.pending} pending</div></td>
                            <td style={td}>{room.usage.activeRatePlans} active / {room.usage.ratePlans}</td>
                            <td style={td}>{c ? <InventoryChip value={c.inventory} /> : '—'}</td>
                            <td style={td}>{c ? <ReadinessChip value={c.readiness} blockers={c.blockers} /> : '—'}</td>
                            <td style={td}>{c && c.blockers.length ? c.blockers.map((b) => <div key={b} title={reasonText(b)}><code>{b}</code></div>) : '—'}</td>
                            <td style={{ ...td, whiteSpace: 'nowrap' }}>{canManage ? <button type="button" className="admin-btn" onClick={() => { setFlash(null); setEditing(room.id) }}>Edit</button> : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </ScrollRegion>
              )}
            </div>
            {editing && canManage && <RoomEditor key={editing} hotelId={hotelId} view={view} room={editing === 'new' ? undefined : view.rooms.find((r) => r.id === editing)} onClose={() => setEditing(null)} onDone={done} />}
            <ChildAgeRules view={view} />
          </>
        )}
      </OpsState>
    </div>
  )
}

function ChildAgeRules({ view }: { view: HotelRoomsView }) {
  const wantsChildren = view.rooms.some((r) => r.isActive && r.maxChildren > 0)
  return (
    <section className="workspace-panel" style={{ padding: 18 }} aria-label="Child-age rules" data-testid="child-age-rules">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Child-age rules (from contracts)</h2>
      <p style={note}>Child ages and extra-bed terms are contract policies, not room data, and are shown here read-only. Edit them on the contract.</p>
      {view.childPolicies === null ? <p role="status" style={{ ...note, color: '#8a5a00' }}>Contract child policies are unavailable to the API database role.</p>
        : view.childPolicies.length === 0 ? <p style={{ fontSize: 12 }}>{wantsChildren ? 'No child-age rule is recorded on any contract for this hotel, although at least one active room accepts children.' : 'No child-age rule is recorded on any contract for this hotel.'}</p>
        : (
          <ScrollRegion label="Child-age rules"><table style={tableStyle} aria-label="Child-age rules">
            <thead><tr>{['Contract', 'Supplier', 'Ages', 'Extra bed', 'Supplement'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
            <tbody>{view.childPolicies.map((p, i) => <tr key={`${p.contractId}-${i}`}><td style={td}>{p.contractCode}</td><td style={td}>{p.supplierName}</td><td style={td}>{p.minAge}–{p.maxAge}</td><td style={td}>{p.extraBedAllowed ? 'Allowed' : 'Not allowed'}</td><td style={td}>{p.supplementMinor !== null && p.currency ? formatMinorUnits(p.supplementMinor, p.currency) : '—'}</td></tr>)}</tbody></table></ScrollRegion>
        )}
    </section>
  )
}

function RoomEditor({ hotelId, view, room, onClose, onDone }: { hotelId: string; view: HotelRoomsView; room?: HotelRoomView; onClose: () => void; onDone: (text: string) => void }) {
  const initial = useMemo(() => toForm(room), [room])
  const [form, setForm] = useState<RoomForm>(initial)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const key = useRef<string | null>(null)
  const [error, setError] = useState<{ message: string; details: string[]; requestId: string | null; stale: boolean } | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const set = <K extends keyof RoomForm>(k: K, v: RoomForm[K]) => { key.current = null; setForm((f) => ({ ...f, [k]: v })) }
  const isNew = !room
  const amenitiesOn = view.amenitiesAvailable

  function changes(): Omit<RoomSave, 'idempotencyKey' | 'expectedToken'> {
    const out: Record<string, unknown> = {}
    if (isNew || form.name !== initial.name) out.name = form.name.trim()
    if (isNew || form.code !== initial.code) out.code = form.code.trim()
    for (const k of ['maxAdults', 'maxChildren', 'maxOccupancy'] as const) if (isNew || form[k] !== initial[k]) out[k] = form[k] === '' ? NaN : Number(form[k])
    const bedding: Record<string, unknown> = {}
    if (isNew ? form.description : form.description !== initial.description) bedding.description = form.description.trim() === '' ? null : form.description.trim()
    if (JSON.stringify(bedList(form.beds)) !== JSON.stringify(bedList(initial.beds))) bedding.beds = bedList(form.beds)
    if (isNew ? form.extraBed !== 'UNKNOWN' : form.extraBed !== initial.extraBed) bedding.extraBed = form.extraBed
    if (Object.keys(bedding).length) out.bedding = bedding
    if (amenitiesOn && (isNew ? form.amenities.length > 0 : !sameAmenities(form.amenities, initial.amenities))) out.amenities = form.amenities
    return out as never
  }
  const dirty = isNew || Object.keys(changes()).length > 0

  async function save() {
    if (inFlight.current || !dirty) return
    inFlight.current = true; setBusy(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const body = { ...changes(), idempotencyKey: key.current, ...(reason.trim() ? { reason: reason.trim() } : {}) } as RoomSave
      const { data } = room ? await updateHotelRoom(hotelId, room.id, { ...body, expectedToken: room.concurrencyToken }) : await createHotelRoom(hotelId, body)
      key.current = null
      onDone(`${isNew ? 'Room created' : 'Room saved'}: ${data.room.name}. Request id ${data.auditRequestId || 'not recorded'}.`)
    } catch (e) { const p = apiErrorParts(e, 'save the room'); setError({ message: p.message, details: p.details, requestId: p.requestId, stale: p.code === 'ROOM_STALE' }) } finally { inFlight.current = false; setBusy(false) }
  }

  async function archive(active: boolean) {
    if (!room || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const { data } = await (active ? restoreHotelRoom : archiveHotelRoom)(hotelId, room.id, { idempotencyKey: key.current, expectedToken: room.concurrencyToken, reason: reason.trim() })
      key.current = null
      onDone(`Room ${active ? 'restored' : 'archived'}: ${data.room.name}. Request id ${data.auditRequestId || 'not recorded'}.`)
    } catch (e) { const p = apiErrorParts(e, `${active ? 'restore' : 'archive'} the room`); setError({ message: p.message, details: p.details, requestId: p.requestId, stale: p.code === 'ROOM_STALE' }) } finally { inFlight.current = false; setBusy(false) }
  }

  return (
    <form className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 12 }} aria-label={isNew ? 'Add room' : `Edit room ${room.name}`} data-testid="room-editor" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <h2 style={{ fontSize: 14, margin: 0 }}>{isNew ? 'Add room' : `Edit ${room.name}`}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <label style={field}>Room name<input className="input-wrap" value={form.name} maxLength={120} required onChange={(e) => set('name', e.target.value)} /></label>
        <label style={field}>Room code<input className="input-wrap" value={form.code} maxLength={40} required onChange={(e) => set('code', e.target.value)} /></label>
        <label style={field}>Max adults<input className="input-wrap" type="number" min={1} value={form.maxAdults} onChange={(e) => set('maxAdults', e.target.value)} /></label>
        <label style={field}>Max children<input className="input-wrap" type="number" min={0} value={form.maxChildren} onChange={(e) => set('maxChildren', e.target.value)} /></label>
        <label style={field}>Max total occupancy<input className="input-wrap" type="number" min={1} value={form.maxOccupancy} onChange={(e) => set('maxOccupancy', e.target.value)} /></label>
      </div>
      <p style={note}>Maximum occupancy must be at least adults plus children. Child ages are set by contract policy, shown below the rooms.</p>
      <fieldset style={{ border: '1px solid #e6eef0', padding: 12, margin: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 600 }}>Bedding</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
          {BED_TYPES.map((t) => <label key={t} style={field}>{BED_LABEL[t]} beds<input className="input-wrap" type="number" min={0} max={9} value={form.beds[t]} onChange={(e) => set('beds', { ...form.beds, [t]: e.target.value })} /></label>)}
        </div>
        <label style={{ ...field, marginTop: 10 }}>Bedding description<input className="input-wrap" value={form.description} maxLength={200} onChange={(e) => set('description', e.target.value)} /></label>
        <label style={{ ...field, marginTop: 10 }}>Extra bed<select className="input-wrap" value={form.extraBed} onChange={(e) => set('extraBed', e.target.value as ExtraBedSupport)}>{EXTRA_BED_SUPPORT.map((v) => <option key={v} value={v}>{v === 'SUPPORTED' ? 'Supported' : v === 'NOT_SUPPORTED' ? 'Not supported' : 'Not recorded'}</option>)}</select></label>
      </fieldset>
      <fieldset style={{ border: '1px solid #e6eef0', padding: 12, margin: 0 }}>
        <legend style={{ fontSize: 12, fontWeight: 600 }}>Room amenities</legend>
        {amenitiesOn ? <AmenityPicker scope="ROOM" idPrefix={`room-${room?.id ?? 'new'}`} value={form.amenities} onChange={(v) => set('amenities', v)} /> : <p style={note}>Unavailable to the API database role.</p>}
      </fieldset>
      {!isNew && <label style={field}>Reason (optional for edits, required to archive or restore)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => { key.current = null; setReason(e.target.value) }} /></label>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="submit" className="button primary" disabled={busy || !dirty} data-testid="room-save">{busy ? 'Saving…' : isNew ? 'Create room' : 'Save room'}</button>
        <button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button>
        {room && <button type="button" className="admin-btn" disabled={busy} onClick={() => (room.isActive ? setConfirmArchive(true) : reason.trim().length < 3 ? setError({ message: 'Enter a reason of at least 3 characters to restore the room.', details: [], requestId: null, stale: false }) : void archive(true))} data-testid="room-archive">{room.isActive ? 'Archive room' : 'Restore room'}</button>}
      </div>
      {room && confirmArchive && room.isActive && (
        <div role="alertdialog" aria-label="Confirm archive" className="workspace-panel" style={{ padding: 12 }} data-testid="archive-confirm">
          <p style={{ margin: 0, fontSize: 12 }}>Archiving does not delete anything. {room.usage.activeRatePlans} active rate plan{room.usage.activeRatePlans === 1 ? '' : 's'} and {room.usage.mappings.mapped} approved mapping{room.usage.mappings.mapped === 1 ? '' : 's'} stay on record, and the room stops being sold until it is restored. A reason is required.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="button primary" disabled={busy || reason.trim().length < 3} onClick={() => void archive(false)} data-testid="archive-confirm-button">Confirm archive</button>
            <button type="button" className="admin-btn" onClick={() => setConfirmArchive(false)}>Keep active</button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="admin-error" data-testid="room-error" style={{ padding: 12 }}>
          <strong>{error.message}</strong>
          {error.details.length > 0 && <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul>}
          {error.requestId && <div style={note}>Request id: <code>{error.requestId}</code></div>}
          {error.stale && <div style={note}>Close this editor and reopen the room to load the latest version.</div>}
        </div>
      )}
    </form>
  )
}
