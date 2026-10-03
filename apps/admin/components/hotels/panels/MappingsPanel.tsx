'use client'

import { useRef, useState } from 'react'
import type { AuditEventView, HotelMappingRow, HotelMappingsView, MappingState, Paged, RoomMappingRow } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { useCan } from '@/lib/auth/capabilities'
import { apiErrorParts } from '@/lib/hotel-setup-ui'
import { getHotelAudit, getHotelMappings } from '@/lib/data/hotel-commercial'
import { getSuppliers } from '@/lib/data'
import { createSupplierHotelMapping, createSupplierRoomMapping, decideSupplierHotelMapping, decideSupplierRoomMapping, type MappingDecision } from '@/lib/data/hotel-mappings'
import { mappingTone } from '@/lib/hotel-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'

const note = { color: '#3f565c', fontSize: 11, margin: 0 } as const
const field = { display: 'grid', gap: 2, fontSize: 12, color: '#17333e' } as const
const LABEL: Record<string, string> = { PENDING: 'PENDING REVIEW', MAPPED: 'VERIFIED', REJECTED: 'REJECTED' }

type Flash = { tone: 'ok' | 'bad'; text: string; details: string[]; requestId: string | null }

/**
 * Supplier mappings for one canonical hotel. A hotel may have many (one per supplier). Nothing is approved automatically: every
 * decision is a person's, with a reason, and is audited. A supplier hotel or room id identifies one record per supplier, so a
 * second claim is refused with a conflict that names what it collides with.
 */
export function MappingsPanel({ hotelId }: { hotelId: string }) {
  const can = useCan()
  const canManage = can('supply.mappings.manage')
  const [version, setVersion] = useState(0)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [busy, setBusy] = useState(false); const inFlight = useRef(false)
  const { state, reload } = useOpsQuery(() => getHotelMappings(hotelId), [hotelId, version])

  async function act(work: () => Promise<{ requestId: string | null }>, done: string) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setFlash(null)
    try { const { requestId } = await work(); setFlash({ tone: 'ok', text: done, details: [], requestId }); setVersion((v) => v + 1) }
    catch (e) { const p = apiErrorParts(e, 'complete the mapping change'); setFlash({ tone: 'bad', text: p.message, details: p.details, requestId: p.requestId }) }
    finally { inFlight.current = false; setBusy(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {flash && (
        <div role={flash.tone === 'bad' ? 'alert' : 'status'} data-testid={flash.tone === 'bad' ? 'mapping-error' : 'mapping-flash'} className={flash.tone === 'bad' ? 'admin-error' : 'workspace-panel'} style={{ padding: 12 }}>
          <strong>{flash.text}</strong>
          {flash.details.length > 0 && <ul>{flash.details.map((d) => <li key={d}>{d}</li>)}</ul>}
          {flash.requestId && <div style={note}>Request id: <code>{flash.requestId}</code></div>}
        </div>
      )}
      <OpsState state={state} onRetry={reload}>
        {(data) => (
          <>
            <HotelMappings hotelId={hotelId} data={data} canManage={canManage} busy={busy} act={act} />
            <RoomMappings data={data} canManage={canManage} busy={busy} act={act} />
            <BoardNote />
            <History hotelId={hotelId} version={version} />
          </>
        )}
      </OpsState>
    </div>
  )
}

type Act = (work: () => Promise<{ requestId: string | null }>, done: string) => Promise<void>

function Decision({ row, noun, busy, onDecide }: { row: { status: string }; noun: string; busy: boolean; onDecide: (decision: MappingDecision, reason: string) => void }) {
  const [open, setOpen] = useState<MappingDecision | null>(null)
  const [reason, setReason] = useState('')
  // The API allows: PENDING to verified or rejected; verified or rejected back to PENDING by reopening.
  const options: MappingDecision[] = row.status === 'PENDING' ? ['approve', 'reject'] : ['reopen']
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{options.map((d) => <button key={d} type="button" className="admin-btn" disabled={busy} aria-expanded={open === d} onClick={() => { setOpen(open === d ? null : d); setReason('') }}>{d === 'approve' ? 'Approve' : d === 'reject' ? 'Reject' : 'Reopen'} {noun}</button>)}</div>
      {open && (
        <form style={{ display: 'flex', gap: 6, alignItems: 'end', flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) { onDecide(open, reason.trim()); setOpen(null); setReason('') } }}>
          <label style={field}>Reason for {open === 'approve' ? 'approving' : open === 'reject' ? 'rejecting' : 'reopening'} (required)<input className="input-wrap" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} autoFocus /></label>
          <button type="submit" className="button primary" disabled={busy || reason.trim().length < 3}>Confirm {open}</button>
        </form>
      )}
    </div>
  )
}

function HotelMappings({ hotelId, data, canManage, busy, act }: { hotelId: string; data: HotelMappingsView; canManage: boolean; busy: boolean; act: Act }) {
  return (
    <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Supplier hotel mappings" data-testid="hotel-mappings">
      <h2 style={{ fontSize: 14, margin: 0 }}>Supplier hotel mappings ({data.hotelMappings.length})</h2>
      <p style={note}>A hotel may be mapped to several suppliers, one mapping each. Until a mapping is verified, that supplier cannot sell this hotel. Nothing is verified automatically.</p>
      {data.hotelMappings.length === 0 ? <p data-testid="hotel-mapping-empty" style={{ fontSize: 12 }}>No supplier hotel mapping exists. Until a mapping is approved, no supplier can sell this hotel.</p> : (
        <ScrollRegion label="Hotel mappings"><table style={tableStyle} aria-label="Hotel mappings">
          <thead><tr>{['Supplier', 'Supplier hotel id', 'Status', 'Confidence', 'Provenance', 'Created', 'Updated', ...(canManage ? ['Decision'] : [])].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
          <tbody>{data.hotelMappings.map((m: HotelMappingRow) => (
            <tr key={m.id} data-mapping-id={m.id} data-status={m.status}>
              <td style={td}>{m.supplierName}</td><td style={td}><code>{m.supplierHotelId}</code></td>
              <td style={td}><Chip tone={mappingTone(m.status as MappingState)}>{LABEL[m.status] ?? m.status}</Chip></td>
              <td style={td}>{m.confidence ?? '—'}</td><td style={td}>{m.provenance ?? 'not recorded'}</td><td style={td}>{when(m.createdAt)}</td><td style={td}>{when(m.updatedAt)}</td>
              {canManage && <td style={td}><Decision row={m} noun="hotel mapping" busy={busy} onDecide={(d, reason) => void act(() => decideSupplierHotelMapping(m.id, d, reason), `Hotel mapping ${d === 'approve' ? 'verified' : d === 'reject' ? 'rejected' : 'reopened'}.`)} /></td>}
            </tr>))}</tbody></table></ScrollRegion>
      )}
      {canManage && <NewHotelMapping hotelId={hotelId} busy={busy} act={act} />}
    </section>
  )
}

function NewHotelMapping({ hotelId, busy, act }: { hotelId: string; busy: boolean; act: Act }) {
  const [open, setOpen] = useState(false)
  const suppliers = useOpsQuery(() => (open ? getSuppliers('pageSize=100') : Promise.resolve(null)), [open])
  const [supplierId, setSupplierId] = useState(''); const [supplierHotelId, setSupplierHotelId] = useState(''); const [confidence, setConfidence] = useState(''); const [source, setSource] = useState('')
  if (!open) return <div><button type="button" className="admin-btn" onClick={() => setOpen(true)}>Add supplier mapping</button></div>
  const list = suppliers.state.status === 'ready' && suppliers.state.data ? suppliers.state.data.items : []
  return (
    <form aria-label="New supplier hotel mapping" data-testid="new-hotel-mapping" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}
      onSubmit={(e) => { e.preventDefault(); void act(() => createSupplierHotelMapping({ supplierId, hotelId, supplierHotelId: supplierHotelId.trim(), ...(confidence !== '' ? { confidence: Number(confidence) } : {}), ...(source.trim() ? { sourceMetadata: { source: source.trim() } } : {}) }), 'Supplier mapping created as PENDING REVIEW. It is not verified until someone approves it.').then(() => { setSupplierHotelId(''); setConfidence(''); setSource('') }) }}>
      <label style={field}>Supplier<select className="input-wrap" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required><option value="">Select…</option>{list.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select></label>
      <label style={field}>Supplier hotel id<input className="input-wrap" value={supplierHotelId} onChange={(e) => setSupplierHotelId(e.target.value)} required maxLength={120} /></label>
      <label style={field}>Confidence (0-100, optional)<input className="input-wrap" type="number" min={0} max={100} value={confidence} onChange={(e) => setConfidence(e.target.value)} /></label>
      <label style={field}>Source (optional)<input className="input-wrap" value={source} maxLength={80} onChange={(e) => setSource(e.target.value)} placeholder="For example supplier content feed" /></label>
      <button type="submit" className="button primary" disabled={busy || !supplierId || !supplierHotelId.trim()}>Create mapping</button>
      <button type="button" className="admin-btn" onClick={() => setOpen(false)}>Close</button>
    </form>
  )
}

function RoomMappings({ data, canManage, busy, act }: { data: HotelMappingsView; canManage: boolean; busy: boolean; act: Act }) {
  const [parent, setParent] = useState('')
  const [supplierRoomId, setSupplierRoomId] = useState(''); const [roomTypeId, setRoomTypeId] = useState('')
  const roomChoices = Array.from(new Map(data.unmappedRooms.map((r) => [r.roomTypeId, r.roomName])).entries())
  const verified = data.hotelMappings.filter((m) => m.status === 'MAPPED')
  return (
    <section className="workspace-panel" style={{ padding: 18, display: 'grid', gap: 10 }} aria-label="Supplier room mappings" data-testid="room-mappings">
      <h2 style={{ fontSize: 14, margin: 0 }}>Supplier room mappings ({data.roomMappings.length})</h2>
      <p style={note}>Rooms are mapped one canonical room at a time and are never matched by name. A room mapping can be approved only after its hotel mapping is verified.</p>
      {data.roomMappings.length === 0 ? <p data-testid="room-mapping-empty" style={{ fontSize: 12 }}>No supplier room mapping exists.</p> : (
        <ScrollRegion label="Room mappings"><table style={tableStyle} aria-label="Room mappings">
          <thead><tr>{['Canonical room', 'Supplier room id', 'Under', 'Status', 'Confidence', 'Provenance', 'Updated', ...(canManage ? ['Decision'] : [])].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
          <tbody>{data.roomMappings.map((m: RoomMappingRow) => (
            <tr key={m.id} data-status={m.status}>
              <td style={td}>{m.roomName}</td><td style={td}><code>{m.supplierRoomId}</code></td><td style={td}>{data.hotelMappings.find((h) => h.id === m.hotelMappingId)?.supplierName ?? '—'}</td>
              <td style={td}><Chip tone={mappingTone(m.status as MappingState)}>{LABEL[m.status] ?? m.status}</Chip></td><td style={td}>{m.confidence ?? '—'}</td><td style={td}>{m.provenance ?? 'not recorded'}</td><td style={td}>{when(m.updatedAt)}</td>
              {canManage && <td style={td}><Decision row={m} noun="room mapping" busy={busy} onDecide={(d, reason) => void act(() => decideSupplierRoomMapping(m.hotelMappingId, m.id, d, reason), `Room mapping ${d === 'approve' ? 'verified' : d === 'reject' ? 'rejected' : 'reopened'}.`)} /></td>}
            </tr>))}</tbody></table></ScrollRegion>
      )}
      {data.unmappedRooms.length > 0 && (
        <div role="status" data-testid="unmapped-rooms">
          <strong style={{ fontSize: 12 }}>Active rooms without a verified mapping</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16, fontSize: 12 }}>{data.unmappedRooms.map((r) => <li key={`${r.hotelMappingId}-${r.roomTypeId}`}>{r.roomName} <span style={{ color: '#3f565c' }}>(under {r.supplierName})</span></li>)}</ul>
        </div>
      )}
      {canManage && verified.length > 0 && roomChoices.length > 0 && (
        <form aria-label="New supplier room mapping" data-testid="new-room-mapping" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}
          onSubmit={(e) => { e.preventDefault(); void act(() => createSupplierRoomMapping(parent || verified[0].id, { supplierRoomId: supplierRoomId.trim(), roomTypeId }), 'Room mapping created as PENDING REVIEW.').then(() => setSupplierRoomId('')) }}>
          <label style={field}>Under supplier mapping<select className="input-wrap" value={parent || verified[0].id} onChange={(e) => setParent(e.target.value)}>{verified.map((m) => <option key={m.id} value={m.id}>{m.supplierName} · {m.supplierHotelId}</option>)}</select></label>
          <label style={field}>Canonical room<select className="input-wrap" value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)} required><option value="">Select…</option>{roomChoices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label style={field}>Supplier room id<input className="input-wrap" value={supplierRoomId} onChange={(e) => setSupplierRoomId(e.target.value)} required maxLength={120} /></label>
          <button type="submit" className="button primary" disabled={busy || !roomTypeId || !supplierRoomId.trim()}>Create room mapping</button>
        </form>
      )}
      {canManage && verified.length === 0 && data.hotelMappings.length > 0 && <p style={note}>Verify a hotel mapping first; room mappings are created under a verified one.</p>}
    </section>
  )
}

function BoardNote() {
  return (
    <section className="workspace-panel" style={{ padding: 18 }} aria-label="Board mappings" data-testid="board-note">
      <h2 style={{ fontSize: 14, margin: '0 0 6px' }}>Board basis mapping</h2>
      <p style={{ margin: 0, fontSize: 12, color: '#3f565c' }}>Not modelled yet. Board bases are canonical per tenant and each rate plan names one directly; the schema stores no supplier board code mapping, so none can be recorded or verified here.</p>
    </section>
  )
}

function History({ hotelId, version }: { hotelId: string; version: number }) {
  const can = useCan()
  const allowed = can('audit.read')
  const hotel = useOpsQuery<Paged<AuditEventView> | null>(() => (allowed ? getHotelAudit(hotelId, { entityType: 'supplier_hotel_mapping', pageSize: 20 }) : Promise.resolve(null)), [hotelId, allowed, version])
  const room = useOpsQuery<Paged<AuditEventView> | null>(() => (allowed ? getHotelAudit(hotelId, { entityType: 'supplier_room_mapping', pageSize: 20 }) : Promise.resolve(null)), [hotelId, allowed, version])
  const rows = hotel.state.status === 'ready' && room.state.status === 'ready' ? [...(hotel.state.data?.items ?? []), ...(room.state.data?.items ?? [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25) : []
  return (
    <section className="workspace-panel" style={{ padding: 18 }} aria-label="Mapping history" data-testid="mapping-history">
      <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Mapping history</h2>
      {!allowed ? <p style={{ fontSize: 12 }}>Mapping history needs the audit permission.</p> : hotel.state.status === 'loading' || room.state.status === 'loading' ? <p style={{ fontSize: 12 }}>Loading history…</p> : hotel.state.status === 'failed' || room.state.status === 'failed' ? <p role="alert" style={{ fontSize: 12 }}>The mapping history could not be loaded.</p> : rows.length === 0 ? <p style={{ fontSize: 12 }}>No mapping decision has been recorded for this hotel.</p> : (
        <ScrollRegion label="Mapping history"><table style={tableStyle} aria-label="Mapping history">
          <thead><tr>{['When', 'Actor', 'Action', 'Status', 'Supplier ids', 'Reason', 'Request id'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((e) => {
            const p = e.payload as { previousStatus?: string; newStatus?: string; status?: string; reason?: string; supplierHotelId?: string; supplierRoomId?: string }
            return <tr key={e.id}><td style={td}>{when(e.at)}</td><td style={td}>{e.userId ? <code>{e.userId}</code> : e.actorType}</td><td style={td}><code>{e.action}</code></td><td style={td}>{p.previousStatus ? `${p.previousStatus} → ${p.newStatus}` : p.status ?? '—'}</td><td style={td}>{[p.supplierHotelId, p.supplierRoomId].filter(Boolean).join(' / ') || '—'}</td><td style={td}>{p.reason ?? '—'}</td><td style={td}>{e.requestId ? <code>{e.requestId}</code> : '—'}</td></tr>
          })}</tbody></table></ScrollRegion>
      )}
    </section>
  )
}
