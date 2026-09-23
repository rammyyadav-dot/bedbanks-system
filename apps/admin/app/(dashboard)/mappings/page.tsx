'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { AdminLoadingState, AdminServiceUnavailable, AccessDenied, AuthRequired } from '@/components/auth/AuthorizationStates'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'
import type { HotelMappingRead, RoomMappingRead } from '@bedbanks/contracts'

type HotelMapping = HotelMappingRead & { supplier: { displayName: string }; hotel: { name: string; city: string } }
type RoomMapping = RoomMappingRead & { roomType: { name: string; code: string } }
type Options = { suppliers: { id: string; displayName: string }[]; hotels: { id: string; name: string; city: string }[] }
type RoomOption = { id: string; name: string; code: string }
type State = 'loading' | 'ready' | 'auth' | 'forbidden' | 'error'
const base = '/supply/mappings/hotels'

function errorMessage(error: unknown) { return error instanceof ApiResponseError ? error.message : 'The request failed.' }

export default function MappingsPage() {
  const [state, setState] = useState<State>('loading')
  const [hotels, setHotels] = useState<HotelMapping[]>([])
  const [options, setOptions] = useState<Options>({ suppliers: [], hotels: [] })
  const [selected, setSelected] = useState<string | null>(null)
  const [rooms, setRooms] = useState<RoomMapping[]>([])
  const [roomOptions, setRoomOptions] = useState<RoomOption[]>([])
  const [roomState, setRoomState] = useState<State>('ready')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [hotelForm, setHotelForm] = useState({ supplierId: '', hotelId: '', supplierHotelId: '', confidence: '' })
  const [roomForm, setRoomForm] = useState({ supplierRoomId: '', roomTypeId: '', confidence: '' })
  const [metadata, setMetadata] = useState({ confidence: '', sourceMetadata: '{}' })

  const refresh = useCallback(async () => {
    const [mappings, choices] = await Promise.all([apiRequest<HotelMapping[]>(base), apiRequest<Options>('/supply/mappings/options')])
    setHotels(mappings); setOptions(choices); setState('ready')
  }, [])
  useEffect(() => { let active = true; refresh().catch(error => { if (!active) return; setState(error instanceof ApiResponseError && error.status === 401 ? 'auth' : error instanceof ApiResponseError && error.status === 403 ? 'forbidden' : 'error') }); return () => { active = false } }, [refresh])
  const loadRooms = useCallback(async (mappingId: string) => {
    setRoomState('loading')
    try {
      const [mappingRooms, choices] = await Promise.all([
        apiRequest<RoomMapping[]>(`${base}/${mappingId}/rooms`),
        apiRequest<RoomOption[]>(`/supply/mappings/options/rooms/${mappingId}`),
      ])
      setRooms(mappingRooms); setRoomOptions(choices); setRoomState('ready')
    } catch (error) {
      setRoomState(error instanceof ApiResponseError && error.status === 401 ? 'auth' : error instanceof ApiResponseError && error.status === 403 ? 'forbidden' : 'error')
    }
  }, [])
  useEffect(() => { if (selected) void loadRooms(selected) }, [selected, loadRooms])

  async function mutate(path: string, method: 'POST' | 'PATCH', body?: object) {
    setBusy(true); setNotice('')
    try {
      await apiRequest(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      await refresh()
      if (selected) await loadRooms(selected)
      setNotice('Mapping change saved and audited.')
    } catch (error) { setNotice(errorMessage(error)) } finally { setBusy(false) }
  }
  async function addHotel(event: FormEvent) {
    event.preventDefault()
    await mutate(base, 'POST', { supplierId: hotelForm.supplierId, hotelId: hotelForm.hotelId,
      supplierHotelId: hotelForm.supplierHotelId, confidence: hotelForm.confidence === '' ? null : Number(hotelForm.confidence) })
  }
  async function addRoom(event: FormEvent) {
    event.preventDefault(); if (!selected) return
    await mutate(`${base}/${selected}/rooms`, 'POST', { supplierRoomId: roomForm.supplierRoomId, roomTypeId: roomForm.roomTypeId,
      confidence: roomForm.confidence === '' ? null : Number(roomForm.confidence) })
  }
  const current = hotels.find(hotel => hotel.id === selected)
  return <div className="admin-page">
    <PageHeader eyebrow="SUPPLIER SUPPLY · IDENTITY" title="Mapping governance" description="Resolve supplier hotel and room codes to canonical fBeds inventory." />
    {state === 'loading' && <AdminLoadingState />}
    {state === 'auth' && <AuthRequired />}
    {state === 'forbidden' && <AccessDenied permission="supply.mappings.read" />}
    {state === 'error' && <AdminServiceUnavailable onRetry={() => window.location.reload()} />}
    {state === 'ready' && <>
      {notice && <p role="status" className="workspace-panel" style={{ padding: 14 }}>{notice}</p>}
      <section className="workspace-panel" style={{ padding: 20, marginBottom: 16 }}>
        <h2>New hotel mapping</h2>
        <form onSubmit={addHotel} style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
          <label>Supplier<select className="input-wrap" required value={hotelForm.supplierId} onChange={event => setHotelForm({ ...hotelForm, supplierId: event.target.value })}><option value="">Select supplier</option>{options.suppliers.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <label>Canonical hotel<select className="input-wrap" required value={hotelForm.hotelId} onChange={event => setHotelForm({ ...hotelForm, hotelId: event.target.value })}><option value="">Select hotel</option>{options.hotels.map(item => <option key={item.id} value={item.id}>{item.name} · {item.city}</option>)}</select></label>
          <label>Supplier hotel ID<input className="input-wrap" required value={hotelForm.supplierHotelId} onChange={event => setHotelForm({ ...hotelForm, supplierHotelId: event.target.value })} /></label>
          <label>Confidence (0–100)<input className="input-wrap" type="number" min="0" max="100" value={hotelForm.confidence} onChange={event => setHotelForm({ ...hotelForm, confidence: event.target.value })} /></label>
          <button className="button primary" disabled={busy}>Create pending mapping</button>
        </form>
      </section>
      <section className="workspace-panel" style={{ padding: 20 }}>
        <h2>Hotel mappings</h2>
        {!hotels.length && <p>No mappings in this tenant.</p>}
        {hotels.map(item => <div key={item.id} style={{ borderTop: '1px solid #E5E7EB', padding: '14px 0' }}>
          <button type="button" onClick={() => { setSelected(item.id); setMetadata({ confidence: item.confidence == null ? '' : String(item.confidence), sourceMetadata: JSON.stringify(item.sourceMetadata) }) }} style={{ fontWeight: 700 }}>{item.supplier.displayName}: {item.supplierHotelId} → {item.hotel.name}</button>
          <span style={{ marginLeft: 12 }}>{item.status} · confidence {item.confidence ?? '—'}</span>
          {item.status === 'PENDING' ? <><button type="button" disabled={busy} onClick={() => mutate(`${base}/${item.id}/approve`, 'POST')}>Approve</button><button type="button" disabled={busy} onClick={() => mutate(`${base}/${item.id}/reject`, 'POST')}>Reject</button></> : <button type="button" disabled={busy} onClick={() => mutate(`${base}/${item.id}/reopen`, 'POST')}>Reopen</button>}
        </div>)}
      </section>
      {selected && <section className="workspace-panel" style={{ padding: 20, marginTop: 16 }}>
        <h2>{current?.hotel.name ?? 'Hotel mapping'} · room identities</h2>
        <p>Canonical hotel: {current?.hotel.name ?? 'Unavailable'}. Only its active room types can be selected.</p>
        <label>Mapping confidence<input type="number" min="0" max="100" className="input-wrap" value={metadata.confidence} onChange={event => setMetadata({ ...metadata, confidence: event.target.value })} /></label>
        <label>Source metadata (JSON object)<textarea className="input-wrap" value={metadata.sourceMetadata} onChange={event => setMetadata({ ...metadata, sourceMetadata: event.target.value })} /></label>
        <button type="button" disabled={busy} onClick={() => { try { mutate(`${base}/${selected}`, 'PATCH', { confidence: metadata.confidence === '' ? null : Number(metadata.confidence), sourceMetadata: JSON.parse(metadata.sourceMetadata) }) } catch { setNotice('Enter a valid JSON object.') } }}>Save hotel metadata</button>
        {roomState === 'loading' && <AdminLoadingState />}
        {roomState === 'auth' && <AuthRequired />}
        {roomState === 'forbidden' && <AccessDenied permission="supply.mappings.read" />}
        {roomState === 'error' && <AdminServiceUnavailable onRetry={() => loadRooms(selected)} />}
        {roomState === 'ready' && <>
          <form onSubmit={addRoom} style={{ display: 'grid', gap: 12, maxWidth: 720, marginTop: 20 }}>
            <label>Supplier room ID<input className="input-wrap" required value={roomForm.supplierRoomId} onChange={event => setRoomForm({ ...roomForm, supplierRoomId: event.target.value })} /></label>
            <label>Canonical room type<select className="input-wrap" required value={roomForm.roomTypeId} onChange={event => setRoomForm({ ...roomForm, roomTypeId: event.target.value })}><option value="">Select room type</option>{roomOptions.map(item => <option key={item.id} value={item.id}>{item.name} · {item.code}</option>)}</select></label>
            <label>Confidence (0–100)<input className="input-wrap" type="number" min="0" max="100" value={roomForm.confidence} onChange={event => setRoomForm({ ...roomForm, confidence: event.target.value })} /></label>
            <button className="button primary" disabled={busy || !roomOptions.length}>Create pending room mapping</button>
          </form>
          {!rooms.length && <p>No supplier room mappings for this hotel.</p>}
          {rooms.map(item => <div key={item.id} style={{ borderTop: '1px solid #E5E7EB', padding: '14px 0' }}>
            <strong>{item.supplierRoomId} → {item.roomType.name}</strong><span style={{ marginLeft: 12 }}>{item.status} · confidence {item.confidence ?? '—'}</span>
            {item.status === 'PENDING' ? <><button type="button" disabled={busy} onClick={() => mutate(`${base}/${selected}/rooms/${item.id}/approve`, 'POST')}>Approve</button><button type="button" disabled={busy} onClick={() => mutate(`${base}/${selected}/rooms/${item.id}/reject`, 'POST')}>Reject</button></> : <button type="button" disabled={busy} onClick={() => mutate(`${base}/${selected}/rooms/${item.id}/reopen`, 'POST')}>Reopen</button>}
            <button type="button" disabled={busy} onClick={() => { const raw = window.prompt('Room confidence (0–100)', item.confidence == null ? '' : String(item.confidence)); if (raw !== null) mutate(`${base}/${selected}/rooms/${item.id}`, 'PATCH', { confidence: raw === '' ? null : Number(raw) }) }}>Edit confidence</button>
          </div>)}
        </>}
      </section>}
    </>}
  </div>
}
