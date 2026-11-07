'use client'

import { useMemo, useRef, useState } from 'react'
import {
  BED_TYPES, EXTRA_BED_SUPPORT, defaultAgeBands, deriveOccupancyPolicy, explainParty, occupancyMatrix, policyProblems,
  type BedType, type ExtraBedSupport, type AmenitySelection, type HotelRoomsView, type HotelRoomView, type RoomAgeBand, type RoomOccupancyPolicy, type RoomParty, type RoomSave,
} from '@bedbanks/contracts'
import { useUnsavedChanges } from '../useUnsavedChanges'
import { AmenityPicker, sameAmenities } from '../AmenityPicker'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { createHotelRoom, updateHotelRoom, archiveHotelRoom, restoreHotelRoom } from '@/lib/data/hotel-rooms'

const BED_LABEL: Record<BedType, string> = { SINGLE: 'Single', DOUBLE: 'Double', QUEEN: 'Queen', KING: 'King', TWIN: 'Twin', SOFA_BED: 'Sofa bed', BUNK: 'Bunk' }
const emptyBeds = () => Object.fromEntries(BED_TYPES.map((type) => [type, ''])) as Record<BedType, string>
const field = { display: 'grid', gap: 4, fontSize: 12, color: 'var(--c-111111)' } as const
const note = { color: 'var(--c-444444)', fontSize: 11, margin: 0 } as const
const num = (value: string) => (value.trim() === '' ? Number.NaN : Number(value))

interface FormState {
  name: string; code: string; active: boolean
  baseOccupancy: string; views: string; inclusions: string; description: string
  maxAdults: string; maxChildren: string; maxOccupancy: string; maxAdultsWithChildren: string
  minOccupancy: string; minAdults: string; maxExtraBeds: string; extraBedCountsTowardMax: boolean
  eventMaxOccupancy: string; lockAfterFirstBooking: boolean; blocked: RoomParty[]
  childrenAllowed: boolean; ageBands: RoomAgeBand[]; sharingBedAllowed: boolean
  childExtraBedAllowed: boolean; adultExtraBedAllowed: boolean
  beds: Record<BedType, string>; extraBed: ExtraBedSupport; amenities: AmenitySelection[]; reason: string
}

function initialState(room?: HotelRoomView): FormState {
  const caps = { maxAdults: room?.maxAdults ?? 2, maxChildren: room?.maxChildren ?? 1, maxOccupancy: room?.maxOccupancy ?? 3 }
  const policy = room?.policy ?? deriveOccupancyPolicy(caps, room?.bedding.extraBed === 'SUPPORTED')
  const beds = emptyBeds()
  for (const bed of room?.bedding.beds ?? []) beds[bed.type] = String(bed.count)
  return {
    name: room?.name ?? '', code: room?.code ?? '', active: room?.isActive ?? true,
    baseOccupancy: String(policy.baseOccupancy), views: policy.views, inclusions: policy.inclusions,
    description: room?.policy ? policy.description : (room?.bedding.description ?? policy.description),
    maxAdults: String(caps.maxAdults), maxChildren: String(caps.maxChildren), maxOccupancy: String(caps.maxOccupancy),
    maxAdultsWithChildren: String(policy.maxAdultsWithChildren), minOccupancy: String(policy.minOccupancy), minAdults: String(policy.minAdults),
    maxExtraBeds: String(policy.maxExtraBeds), extraBedCountsTowardMax: policy.extraBedCountsTowardMax,
    eventMaxOccupancy: policy.eventMaxOccupancy === null ? '' : String(policy.eventMaxOccupancy),
    lockAfterFirstBooking: policy.lockAfterFirstBooking, blocked: policy.blocked, childrenAllowed: policy.childrenAllowed,
    ageBands: policy.ageBands, sharingBedAllowed: policy.sharingBedAllowed, childExtraBedAllowed: policy.childExtraBedAllowed,
    adultExtraBedAllowed: policy.adultExtraBedAllowed, beds, extraBed: room?.bedding.extraBed ?? (policy.maxExtraBeds > 0 ? 'SUPPORTED' : 'UNKNOWN'),
    amenities: room?.amenities ?? [], reason: '',
  }
}

function bedList(beds: Record<BedType, string>) {
  return BED_TYPES.filter((type) => beds[type] !== '' && Number(beds[type]) > 0).map((type) => ({ type, count: Number(beds[type]) }))
}

/** The profile sent to the API. Numeric caps stay as typed so an impossible triple is refused by the server, not clamped away. */
function toPolicy(form: FormState): RoomOccupancyPolicy {
  const maxChildren = num(form.maxChildren)
  const childrenAllowed = Number.isInteger(maxChildren) && maxChildren > 0
  const custom = form.childrenAllowed && form.ageBands.some((band) => band.kind !== 'ADULT')
  const maxOccupancy = num(form.maxOccupancy)
  const maxAdults = num(form.maxAdults)
  const baseCap = Number.isInteger(maxOccupancy) && maxOccupancy >= 1 ? maxOccupancy : 1
  const adultCap = Number.isInteger(maxAdults) && maxAdults >= 1 ? maxAdults : 1
  const extra = num(form.maxExtraBeds)
  return {
    baseOccupancy: Math.min(Math.max(num(form.baseOccupancy) || 1, 1), baseCap),
    views: form.views, inclusions: form.inclusions, description: form.description,
    maxAdultsWithChildren: Math.min(Math.max(num(form.maxAdultsWithChildren) || 0, 0), adultCap),
    minOccupancy: Math.min(Math.max(num(form.minOccupancy) || 1, 1), baseCap),
    minAdults: Math.min(Math.max(num(form.minAdults) || 0, 0), adultCap),
    maxExtraBeds: Number.isInteger(extra) && extra >= 0 ? extra : 0,
    extraBedCountsTowardMax: form.extraBedCountsTowardMax,
    eventMaxOccupancy: form.eventMaxOccupancy.trim() === '' ? null : num(form.eventMaxOccupancy),
    lockAfterFirstBooking: form.lockAfterFirstBooking,
    blocked: form.blocked,
    childrenAllowed,
    ageBands: childrenAllowed ? (custom ? form.ageBands : defaultAgeBands(true)) : defaultAgeBands(false),
    sharingBedAllowed: childrenAllowed && form.sharingBedAllowed,
    childExtraBedAllowed: form.childExtraBedAllowed,
    adultExtraBedAllowed: form.adultExtraBedAllowed,
  }
}

/**
 * Create and edit one room type: room details, occupancy rules and the child age-band engine.
 * The server remains the authority. Percent-of-adult is stored in basis points and is not a sell price.
 */
export function RoomTypeEditor({ hotelId, view, room, onClose, onDone, startArchive = false }: { startArchive?: boolean; hotelId: string; view: HotelRoomsView; room?: HotelRoomView; onClose: () => void; onDone: (text: string) => void }) {
  const initial = useMemo(() => initialState(room), [room])
  const [form, setForm] = useState<FormState>(initial)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const key = useRef<string | null>(null)
  const [error, setError] = useState<{ message: string; details: string[]; requestId: string | null; stale: boolean } | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(startArchive)
  const isNew = !room
  const locked = !!room?.occupancyLocked
  const set = <K extends keyof FormState>(name: K, value: FormState[K]) => { key.current = null; setForm((current) => ({ ...current, [name]: value })) }

  function changes(): Omit<RoomSave, 'idempotencyKey' | 'expectedToken'> {
    const policy = toPolicy(form)
    const out: Record<string, unknown> = {}
    if (isNew || form.name !== initial.name) out.name = form.name.trim()
    if (isNew || form.code !== initial.code) out.code = form.code.trim()
    for (const item of ['maxAdults', 'maxChildren', 'maxOccupancy'] as const) if (isNew || form[item] !== initial[item]) out[item] = num(form[item])
    if (isNew || form.active !== initial.active) out.active = form.active
    const bedding: Record<string, unknown> = {}
    const beddingDescription = form.description.trim().slice(0, 200)
    const initialBedding = initial.description.trim().slice(0, 200)
    if (isNew ? beddingDescription.length > 0 : beddingDescription !== initialBedding) bedding.description = beddingDescription === '' ? null : beddingDescription
    if (JSON.stringify(bedList(form.beds)) !== JSON.stringify(bedList(initial.beds))) bedding.beds = bedList(form.beds)
    if (isNew ? form.extraBed !== 'UNKNOWN' : form.extraBed !== initial.extraBed) bedding.extraBed = form.extraBed
    if (Object.keys(bedding).length) out.bedding = bedding
    if (isNew || JSON.stringify(policy) !== JSON.stringify(toPolicy(initial))) out.policy = policy
    if (view.amenitiesAvailable && (isNew ? form.amenities.length > 0 : !sameAmenities(form.amenities, initial.amenities))) out.amenities = form.amenities
    return out as never
  }
  const dirty = isNew || Object.keys(changes()).length > 0
  useUnsavedChanges(JSON.stringify(form) !== JSON.stringify(initial))
  const previewCaps = { maxAdults: num(form.maxAdults), maxChildren: num(form.maxChildren), maxOccupancy: num(form.maxOccupancy) }
  const previewPolicy = toPolicy(form)
  const previewProblems = policyProblems(previewPolicy, previewCaps)
  const matrix = previewProblems.length === 0 ? occupancyMatrix(previewPolicy, previewCaps) : []

  async function save() {
    if (inFlight.current || !dirty) return
    inFlight.current = true; setBusy(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const body = { ...changes(), idempotencyKey: key.current, ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) } as RoomSave
      const { data } = room ? await updateHotelRoom(hotelId, room.id, { ...body, expectedToken: room.concurrencyToken }) : await createHotelRoom(hotelId, body)
      key.current = null
      onDone(`${isNew ? 'Room created' : 'Room saved'}: ${data.room.name}. Request id ${data.auditRequestId || 'not recorded'}.`)
    } catch (caught) {
      const parts = apiErrorParts(caught, 'save the room')
      setError({ message: parts.message, details: parts.details, requestId: parts.requestId, stale: parts.code === 'ROOM_STALE' })
    } finally { inFlight.current = false; setBusy(false) }
  }

  async function archive(active: boolean) {
    if (!room || inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null); key.current ??= crypto.randomUUID()
    try {
      const { data } = await (active ? restoreHotelRoom : archiveHotelRoom)(hotelId, room.id, { idempotencyKey: key.current, expectedToken: room.concurrencyToken, reason: form.reason.trim() })
      key.current = null
      onDone(`Room ${active ? 'restored' : 'archived'}: ${data.room.name}. Request id ${data.auditRequestId || 'not recorded'}.`)
    } catch (caught) {
      const parts = apiErrorParts(caught, `${active ? 'restore' : 'archive'} the room`)
      setError({ message: parts.message, details: parts.details, requestId: parts.requestId, stale: parts.code === 'ROOM_STALE' })
    } finally { inFlight.current = false; setBusy(false) }
  }

  function setExtra(value: ExtraBedSupport) {
    key.current = null
    setForm((current) => ({
      ...current, extraBed: value,
      maxExtraBeds: value === 'SUPPORTED' ? (num(current.maxExtraBeds) > 0 ? current.maxExtraBeds : '1') : value === 'NOT_SUPPORTED' ? '0' : current.maxExtraBeds,
      childExtraBedAllowed: value === 'SUPPORTED' ? true : value === 'NOT_SUPPORTED' ? false : current.childExtraBedAllowed,
      adultExtraBedAllowed: value === 'SUPPORTED' ? true : value === 'NOT_SUPPORTED' ? false : current.adultExtraBedAllowed,
    }))
  }

  function toggleChildren(allowed: boolean) {
    key.current = null
    setForm((current) => ({
      ...current, childrenAllowed: allowed,
      maxChildren: allowed ? (num(current.maxChildren) > 0 ? current.maxChildren : '1') : '0',
      ageBands: allowed ? (current.ageBands.some((band) => band.kind !== 'ADULT') ? current.ageBands : defaultAgeBands(true)) : defaultAgeBands(false),
      sharingBedAllowed: allowed ? current.sharingBedAllowed : false,
    }))
  }

  function toggleCell(adults: number, children: number) {
    if (locked) return
    const explained = explainParty(previewPolicy, previewCaps, adults, children)
    if (explained.state === 'invalid') return
    key.current = null
    setForm((current) => {
      const exists = current.blocked.some((party) => party.adults === adults && party.children === children)
      return { ...current, blocked: exists ? current.blocked.filter((party) => !(party.adults === adults && party.children === children)) : [...current.blocked, { adults, children }] }
    })
  }

  function addBand() {
    key.current = null
    setForm((current) => {
      const bands = current.ageBands.map((band) => ({ ...band }))
      const adult = bands[bands.length - 1]
      if (!adult || adult.kind !== 'ADULT' || adult.minAge >= 99) return current
      const inserted: RoomAgeBand = { kind: 'CHILD', minAge: adult.minAge, maxAge: adult.minAge, charge: 'PERCENT', percentBp: 5000 }
      adult.minAge += 1
      bands.splice(bands.length - 1, 0, inserted)
      return { ...current, ageBands: bands, childrenAllowed: true, maxChildren: num(current.maxChildren) > 0 ? current.maxChildren : '1' }
    })
  }

  return (
    <form className="room-type-editor" aria-label={isNew ? 'Create room type' : `Edit room ${room.name}`} data-testid="room-editor" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <header className="room-type-editor-intro">
        <h2>{isNew ? 'Create Room Type' : `Edit ${room.name}`}</h2>
      </header>

      <section className="room-type-section" aria-label="Room details">
        <h3>Room Details</h3>
        <div className="room-type-grid">
          <label style={field}>Room Type Name<input className="input-wrap" value={form.name} maxLength={120} required disabled={busy} onChange={(event) => set('name', event.target.value)} /></label>
          <label style={field}>Room code<input className="input-wrap" value={form.code} maxLength={40} required disabled={busy} onChange={(event) => set('code', event.target.value)} /></label>
          <label style={field}>Base Occupancy<input className="input-wrap" type="number" min={1} value={form.baseOccupancy} disabled={busy || locked} onChange={(event) => set('baseOccupancy', event.target.value)} /></label>
          <label style={field}>Status<select className="input-wrap" value={form.active ? 'ACTIVE' : 'INACTIVE'} disabled={busy} onChange={(event) => set('active', event.target.value === 'ACTIVE')}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label>
          <label style={field}>Views<input className="input-wrap" value={form.views} maxLength={160} placeholder="e.g. Sea View, Garden View" disabled={busy} onChange={(event) => set('views', event.target.value)} /></label>
          <label style={field}>Inclusions<input className="input-wrap" value={form.inclusions} maxLength={240} placeholder="e.g. Wi-Fi, beach access" disabled={busy} onChange={(event) => set('inclusions', event.target.value)} /></label>
        </div>
        <label style={{ ...field, marginTop: 10 }}>Description<textarea className="input-wrap" rows={3} maxLength={2000} value={form.description} placeholder="Room description..." disabled={busy} onChange={(event) => set('description', event.target.value)} /></label>
        <fieldset className="room-type-beds">
          <legend>Bedding</legend>
          <div className="room-type-grid">
            {BED_TYPES.map((type) => <label key={type} style={field}>{BED_LABEL[type]} beds<input className="input-wrap" type="number" min={0} max={9} value={form.beds[type]} disabled={busy} onChange={(event) => set('beds', { ...form.beds, [type]: event.target.value })} /></label>)}
            <label style={field}>Extra bed<select className="input-wrap" value={form.extraBed} disabled={busy || locked} onChange={(event) => setExtra(event.target.value as ExtraBedSupport)}>{EXTRA_BED_SUPPORT.map((value) => <option key={value} value={value}>{value === 'SUPPORTED' ? 'Supported' : value === 'NOT_SUPPORTED' ? 'Not supported' : 'Not recorded'}</option>)}</select></label>
          </div>
        </fieldset>
        <fieldset className="room-type-beds"><legend>Room amenities</legend>{view.amenitiesAvailable ? <AmenityPicker scope="ROOM" idPrefix={`room-${room?.id ?? 'new'}`} value={form.amenities} onChange={(value) => set('amenities', value)} /> : <p style={note}>Unavailable to the API database role.</p>}</fieldset>
      </section>

      <section className="room-type-section room-type-section-occupancy" aria-label="Occupancy rules">
        <h3>Occupancy Rules</h3>
        {locked && <p role="status" className="room-type-lock">Locked after a booking. Occupancy limits cannot be reduced.</p>}
        <h4>A. Maximum Occupancy Rules</h4>
        <div className="room-type-grid">
          <label style={field}>Max Total Occupancy<input className="input-wrap" type="number" min={1} value={form.maxOccupancy} disabled={busy || locked} onChange={(event) => set('maxOccupancy', event.target.value)} /></label>
          <label style={field}>Max Adults<input className="input-wrap" type="number" min={1} value={form.maxAdults} disabled={busy || locked} onChange={(event) => set('maxAdults', event.target.value)} /></label>
          <label style={field}>Max Children<input className="input-wrap" type="number" min={0} value={form.maxChildren} disabled={busy || locked} onChange={(event) => { const value = event.target.value; set('maxChildren', value); if (num(value) <= 0) toggleChildren(false); else if (!form.childrenAllowed) toggleChildren(true) }} /></label>
          <label style={field}>Max Adults (when travelling with children)<input className="input-wrap" type="number" min={0} value={form.maxAdultsWithChildren} disabled={busy || locked} onChange={(event) => set('maxAdultsWithChildren', event.target.value)} /></label>
        </div>
        <h4>B. Minimum Occupancy Rules</h4>
        <div className="room-type-grid">
          <label style={field}>Min Total Occupancy<input className="input-wrap" type="number" min={1} value={form.minOccupancy} disabled={busy || locked} onChange={(event) => set('minOccupancy', event.target.value)} /></label>
          <label style={field}>Min Adults Required<input className="input-wrap" type="number" min={0} value={form.minAdults} disabled={busy || locked} onChange={(event) => set('minAdults', event.target.value)} /></label>
        </div>
        <h4>C. Extra Bed Capacity</h4>
        <div className="room-type-grid">
          <label style={field}>Max Extra Beds<input className="input-wrap" type="number" min={0} max={6} value={form.maxExtraBeds} disabled={busy || locked} onChange={(event) => set('maxExtraBeds', event.target.value)} /></label>
          <label className="room-type-check"><input type="checkbox" checked={form.extraBedCountsTowardMax} disabled={busy || locked} onChange={(event) => set('extraBedCountsTowardMax', event.target.checked)} />Extra bed counts toward max occupancy</label>
        </div>
        <h4>D. Event Override Capacity</h4>
        <label style={field}>Event Max Occupancy<input className="input-wrap" type="number" min={1} value={form.eventMaxOccupancy} disabled={busy || locked} onChange={(event) => set('eventMaxOccupancy', event.target.value)} /></label>
        <h4>E. Admin Governance</h4>
        <label className="room-type-check"><input type="checkbox" checked={form.lockAfterFirstBooking} disabled={busy} onChange={(event) => set('lockAfterFirstBooking', event.target.checked)} />Lock after first booking</label>
        <div className="room-type-matrix" aria-label="Allowed occupancy matrix">
          <h4>Occupancy</h4>
          {previewProblems.length > 0 ? <ul>{previewProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : (
            <table>
              <thead><tr><th scope="col">Adults \ Children</th>{Array.from({ length: Math.min(Math.max(previewCaps.maxChildren, 0), 8) + 1 }, (_, children) => <th scope="col" key={children}>{children}</th>)}</tr></thead>
              <tbody>
                {Array.from({ length: Math.min(previewCaps.maxAdults, 12) + 1 }, (_, adults) => (
                  <tr key={adults}><th scope="row">{adults}</th>{Array.from({ length: Math.min(previewCaps.maxChildren, 8) + 1 }, (_, children) => {
                    const cell = matrix.find((item) => item.adults === adults && item.children === children)
                    return <td key={children}><button type="button" className={`room-type-cell ${cell?.state ?? 'invalid'}`} title={cell?.reason} disabled={busy || locked || cell?.state === 'invalid'} onClick={() => toggleCell(adults, children)} aria-label={`${adults} adults, ${children} children, ${cell?.reason ?? 'invalid'}`}>{cell?.state === 'bookable' ? '✓' : '✕'}</button></td>
                  })}</tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="room-type-section room-type-section-child" aria-label="Child policy and extra bed">
        <h3>Child Policy & Extra Bed</h3>
        <h4>Age bands</h4>
        <label className="room-type-check"><input type="checkbox" checked={form.childrenAllowed} disabled={busy || locked} onChange={(event) => toggleChildren(event.target.checked)} />Children allowed in this room</label>
        <div className="room-type-bands">
          {form.ageBands.map((band, index) => (
            <div key={`${band.kind}-${index}`} className={`room-type-band ${band.kind.toLowerCase()}`}>
              <strong>{band.kind === 'INFANT' ? 'Infant' : band.kind === 'CHILD' ? 'Child' : 'Adult'}</strong>
              <label>Age <input type="number" min={0} max={99} value={band.minAge} disabled={busy || locked} onChange={(event) => set('ageBands', form.ageBands.map((item, itemIndex) => itemIndex === index ? { ...item, minAge: num(event.target.value) } : item))} /></label>
              <span>–</span>
              <label><span className="sr-only">Maximum age</span><input aria-label={`${band.kind} maximum age`} type="number" min={0} max={99} value={band.maxAge} disabled={busy || locked} onChange={(event) => set('ageBands', form.ageBands.map((item, itemIndex) => itemIndex === index ? { ...item, maxAge: num(event.target.value) } : item))} /></label>
              <label>Charge<select aria-label={`${band.kind} charge`} value={band.charge} disabled={busy || locked || band.kind === 'ADULT'} onChange={(event) => set('ageBands', form.ageBands.map((item, itemIndex) => itemIndex === index ? { ...item, charge: event.target.value as RoomAgeBand['charge'], percentBp: event.target.value === 'PERCENT' ? item.percentBp ?? 5000 : null } : item))}><option value="FREE">{band.kind === 'ADULT' ? 'Base rate' : 'Free'}</option><option value="PERCENT">% of adult rate</option></select></label>
              {band.charge === 'PERCENT' && <label>% of adult rate<input aria-label={`${band.kind} percent`} type="number" min={1} max={100} value={band.percentBp ? band.percentBp / 100 : 50} disabled={busy || locked} onChange={(event) => set('ageBands', form.ageBands.map((item, itemIndex) => itemIndex === index ? { ...item, percentBp: Math.round(num(event.target.value) * 100) } : item))} /></label>}
              {band.kind !== 'ADULT' && <button type="button" disabled={busy || locked} onClick={() => { key.current = null; set('ageBands', form.ageBands.filter((_, itemIndex) => itemIndex !== index)) }}>Remove</button>}
            </div>
          ))}
        </div>
        <button type="button" className="admin-btn" disabled={busy || locked || !form.childrenAllowed} onClick={addBand}>Add age band</button>
        <h4>Beds</h4>
        <label className="room-type-check"><input type="checkbox" checked={form.sharingBedAllowed} disabled={busy || locked || !form.childrenAllowed} onChange={(event) => set('sharingBedAllowed', event.target.checked)} />Sharing bed allowed</label>
        <label className="room-type-check"><input type="checkbox" checked={form.childExtraBedAllowed} disabled={busy || locked} onChange={(event) => set('childExtraBedAllowed', event.target.checked)} />Extra bed allowed for children</label>
        <label className="room-type-check"><input type="checkbox" checked={form.adultExtraBedAllowed} disabled={busy || locked} onChange={(event) => set('adultExtraBedAllowed', event.target.checked)} />Adult extra bed available</label>
      </section>

      {!isNew && <label style={field}>Reason<input className="input-wrap" value={form.reason} maxLength={500} onChange={(event) => { key.current = null; set('reason', event.target.value) }} /></label>}
      <div className="room-type-actions">
        <button type="button" className="admin-btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || !dirty} data-testid="room-save">{busy ? 'Saving…' : isNew ? 'Create Room Type' : 'Save room'}</button>
        {room && <button type="button" className="admin-btn" disabled={busy} onClick={() => (room.isActive ? setConfirmArchive(true) : form.reason.trim().length < 3 ? setError({ message: 'Enter a reason of at least 3 characters to restore the room.', details: [], requestId: null, stale: false }) : void archive(true))} data-testid="room-archive">{room.isActive ? 'Archive room' : 'Restore room'}</button>}
      </div>
      {room && confirmArchive && room.isActive && (
        <div role="alertdialog" aria-label="Confirm archive" className="workspace-panel" style={{ padding: 12 }} data-testid="archive-confirm">
          <p style={{ margin: 0, fontSize: 12 }}>Archiving does not delete anything. {room.usage.activeRatePlans} active rate plan{room.usage.activeRatePlans === 1 ? '' : 's'} and {room.usage.mappings.mapped} approved mapping{room.usage.mappings.mapped === 1 ? '' : 's'} stay on record, and the room stops being sold until it is restored. A reason is required.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="button primary" disabled={busy || form.reason.trim().length < 3} onClick={() => void archive(false)} data-testid="archive-confirm-button">Confirm archive</button>
            <button type="button" className="admin-btn" onClick={() => setConfirmArchive(false)}>Keep active</button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="admin-error" data-testid="room-error" style={{ padding: 12 }}>
          <strong>{error.message}</strong>
          {error.details.length > 0 && <ul>{error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
          {error.requestId && <div style={note}>Request id: <code>{error.requestId}</code></div>}
          {error.stale && <div style={note}>Close this editor and reopen the room to load the latest version.</div>}
        </div>
      )}
    </form>
  )
}
