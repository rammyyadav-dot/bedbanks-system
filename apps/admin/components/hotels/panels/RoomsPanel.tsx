'use client'

import { Pencil, Trash2 } from 'lucide-react'

import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { childAgeLabel, type BedType, type HotelCommercial360, type HotelRoomView, type HotelRoomsView } from '@bedbanks/contracts'
import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { when } from '@/components/ops/ops-ui'
import { formatMinorUnits } from '@/lib/minor-units'
import { useCan } from '@/lib/auth/capabilities'
import { reasonText } from '@/lib/hotel-ui'
import { getHotelRooms } from '@/lib/data/hotel-rooms'
import { amenityLabel } from '../AmenityPicker'
import { RoomTypeEditor } from './RoomTypeEditor'
import { Chip, InventoryChip, MappingChip, ReadinessChip, ScrollRegion, td, th, tableStyle } from '../ui'

const note = { color: 'var(--c-444444)', fontSize: 11, margin: 0 } as const
const BED_LABEL: Record<BedType, string> = { SINGLE: 'Single', DOUBLE: 'Double', QUEEN: 'Queen', KING: 'King', TWIN: 'Twin', SOFA_BED: 'Sofa bed', BUNK: 'Bunk' }
const primaryBed = (room: HotelRoomView) => room.bedding.beds[0] ? BED_LABEL[room.bedding.beds[0].type] : null

/**
 * Canonical room master for one hotel. Management (create, edit, archive, restore) goes through the Admin room API with a
 * concurrency token and an idempotency key; commercial columns come from the API's own assessment. Rooms are never deleted.
 */
export function RoomsPanel({ data, onChanged, compact = false }: { data: HotelCommercial360; onChanged: () => void; compact?: boolean }) {
  const hotelId = data.hotel.id
  const can = useCan()
  const canManage = can('supply.rooms.manage')
  const initial = useSearchParams().get('room')
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<string | null>(initial)
  const [archiveRequested, setArchiveRequested] = useState(false)
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
            <div className={compact ? 'hotel-room-card' : 'workspace-panel'} style={compact ? undefined : { padding: 18 }} data-testid="hotels-rooms">
              <div className="room-type-toolbar">
                <div>
                  <h2 style={{ fontSize: 14, margin: 0 }}>{compact ? 'Room Types' : `Rooms (${view.rooms.length})`}</h2>
                  <p style={note}>Manage room types for this hotel</p>
                </div>
                {canManage && <button type="button" className="button primary" onClick={() => { setFlash(null); setArchiveRequested(false); setEditing('new') }}>+ Add Room Type</button>}
              </div>
              {!view.amenitiesAvailable && <p role="status" data-testid="amenities-unavailable" style={{ ...note, color: 'var(--c-2a2a2a)' }}>Room amenities are unavailable to the API database role, so they are not shown or saved here.</p>}
              {view.rooms.length > 0 && <div className="room-type-gallery" role="list" aria-label="Room type cards">{view.rooms.map((room) => {
                const bed = primaryBed(room)
                return (
                  <article key={room.id} role="listitem" className="room-type-tile" data-room-id={room.id} data-active={room.isActive}>
                    <header>
                      <h3>{room.name}</h3>
                      {canManage && <div className="hotel-property-room-actions">
                        <button type="button" className="hotel-ui-button" aria-label={`Edit ${room.name}`} onClick={() => { setFlash(null); setArchiveRequested(false); setEditing(room.id) }}><Pencil size={13} /></button>
                        {room.isActive && <button type="button" className="hotel-room-archive" aria-label={`Archive ${room.name}`} title="Archive room" onClick={() => { setFlash(null); setArchiveRequested(true); setEditing(room.id) }}><Trash2 size={13} /></button>}
                      </div>}
                    </header>
                    <div className="room-type-chips">
                      {room.boards?.map((board) => <span key={board} className="room-type-chip">{board}</span>)}
                      {bed && <span className="room-type-chip">{bed}</span>}
                      {!room.isActive && <span className="room-type-chip">Archived</span>}
                    </div>
                    <p>Max {room.maxOccupancy} guests ({room.maxAdults} adults, {room.maxChildren} children)</p>
                    <p>{childAgeLabel(room.policy, room.maxChildren)}</p>
                  </article>
                )
              })}</div>}
              {view.rooms.length === 0 ? <p data-testid="rooms-empty" style={{ color: 'var(--c-444444)' }}>This hotel has no room types. Without a room, nothing can be mapped, priced or sold.</p> : !compact && (
                <ScrollRegion label="Rooms">
                  <table style={tableStyle} aria-label="Rooms">
                    <thead><tr>{['Room', 'Code', 'Occupancy', 'Bedding', 'Amenities', 'Status', 'Supplier mapping', 'Rate plans', 'Inventory', 'Sellability', 'Blockers', 'Actions'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {view.rooms.map((room) => {
                        const c = commercial.get(room.id)
                        return (
                          <tr key={room.id} data-room-id={room.id} data-active={room.isActive}>
                            <td style={td}><strong>{room.name}</strong><div style={{ fontSize: 10, color: 'var(--c-444444)' }}>Updated {when(room.updatedAt)}</div></td>
                            <td style={td}>{room.code}</td>
                            <td style={td}>{room.maxAdults} adults · {room.maxChildren} children · max {room.maxOccupancy}</td>
                            <td style={td}>{room.bedding.beds.length ? room.bedding.beds.map((b) => `${b.count} ${BED_LABEL[b.type]}`).join(', ') : room.bedding.description ?? '—'}<div style={{ fontSize: 10, color: 'var(--c-444444)' }}>Extra bed: {room.bedding.extraBed === 'SUPPORTED' ? 'supported' : room.bedding.extraBed === 'NOT_SUPPORTED' ? 'not supported' : 'not recorded'}</div></td>
                            <td style={td}>{room.amenities === null ? 'Unavailable' : room.amenities.length ? room.amenities.map((a) => amenityLabel(a.code)).join(', ') : 'None recorded'}</td>
                            <td style={td}><Chip tone={room.isActive ? 'ok' : 'neutral'}>{room.isActive ? 'ACTIVE' : 'ARCHIVED'}</Chip></td>
                            <td style={td}>{c ? <MappingChip value={c.mapping} /> : '—'}<div style={{ fontSize: 10, color: 'var(--c-444444)' }}>{room.usage.mappings.mapped} mapped · {room.usage.mappings.pending} pending</div></td>
                            <td style={td}>{room.usage.activeRatePlans} active / {room.usage.ratePlans}</td>
                            <td style={td}>{c ? <InventoryChip value={c.inventory} /> : '—'}</td>
                            <td style={td}>{c ? <ReadinessChip value={c.readiness} blockers={c.blockers} /> : '—'}</td>
                            <td style={td}>{c && c.blockers.length ? c.blockers.map((b) => <div key={b} title={reasonText(b)}><code>{b}</code></div>) : '—'}</td>
                            <td style={{ ...td, whiteSpace: 'nowrap' }}>{canManage ? <button type="button" className="admin-btn" onClick={() => { setFlash(null); setArchiveRequested(false); setEditing(room.id) }}>Edit</button> : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </ScrollRegion>
              )}
            </div>
            {editing && canManage && <RoomTypeEditor key={`${editing}-${archiveRequested}`} startArchive={archiveRequested} hotelId={hotelId} view={view} room={editing === 'new' ? undefined : view.rooms.find((r) => r.id === editing)} onClose={() => setEditing(null)} onDone={done} />}
            {!compact && <ChildAgeRules view={view} />}
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
      <p style={note}>Child ages and extra-bed terms priced on a contract are contract policies, not room data, and are shown here read-only. Edit them on the contract. Age bands saved on the room type are the room's own rules and are not this price.</p>
      {view.childPolicies === null ? <p role="status" style={{ ...note, color: 'var(--c-2a2a2a)' }}>Contract child policies are unavailable to the API database role.</p>
        : view.childPolicies.length === 0 ? <p style={{ fontSize: 12 }}>{wantsChildren ? 'No child-age rule is recorded on any contract for this hotel, although at least one active room accepts children.' : 'No child-age rule is recorded on any contract for this hotel.'}</p>
        : (
          <ScrollRegion label="Child-age rules"><table style={tableStyle} aria-label="Child-age rules">
            <thead><tr>{['Contract', 'Supplier', 'Ages', 'Extra bed', 'Supplement'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
            <tbody>{view.childPolicies.map((p, i) => <tr key={`${p.contractId}-${i}`}><td style={td}>{p.contractCode}</td><td style={td}>{p.supplierName}</td><td style={td}>{p.minAge}–{p.maxAge}</td><td style={td}>{p.extraBedAllowed ? 'Allowed' : 'Not allowed'}</td><td style={td}>{p.supplementMinor !== null && p.currency ? formatMinorUnits(p.supplementMinor, p.currency) : '—'}</td></tr>)}</tbody></table></ScrollRegion>
        )}
    </section>
  )
}

