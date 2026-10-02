import Link from 'next/link'
import type { HotelCommercial360 } from '@bedbanks/contracts'
import { Chip, InventoryChip, MappingChip, ReadinessChip, ScrollRegion, td, th, tableStyle } from '../ui'
import { reasonText } from '@/lib/hotel-ui'

/** Rooms with their supplier mapping, rate plans, inventory and sellability, all as computed by the API. Supplier rooms are never inferred from names. */
export function RoomsPanel({ data }: { data: HotelCommercial360 }) {
  const hotelId = data.hotel.id
  return (
    <div className="workspace-panel" style={{ padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>Rooms ({data.rooms.length})</h2>
        <Link href={`/hotels/${hotelId}/rooms/new`} className="button primary">+ Add room</Link>
      </div>
      {data.rooms.length === 0 ? <p data-testid="rooms-empty" style={{ color: '#3f565c' }}>This hotel has no room types. Without a room, nothing can be mapped, priced or sold.</p> : (
        <ScrollRegion label="Rooms">
          <table style={tableStyle} aria-label="Rooms">
            <thead><tr>{['Room', 'Code', 'Occupancy', 'Status', 'Supplier mapping', 'Supplier room', 'Rate plans', 'Inventory', 'Sellability', 'Blockers'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {data.rooms.map((room) => (
                <tr key={room.id} data-room-id={room.id}>
                  <td style={td}><Link href={`/hotels/${hotelId}/rooms/${room.id}`} style={{ fontWeight: 600 }}>{room.name}</Link></td>
                  <td style={td}>{room.code}</td>
                  <td style={td}>{room.maxAdults} adults · {room.maxChildren} children · max {room.maxOccupancy}</td>
                  <td style={td}><Chip tone={room.isActive ? 'ok' : 'neutral'}>{room.isActive ? 'ACTIVE' : 'INACTIVE'}</Chip></td>
                  <td style={td}><MappingChip value={room.mapping} /></td>
                  <td style={td}>{room.supplierRoomIds.length ? room.supplierRoomIds.map((id) => <code key={id}>{id}</code>) : '—'}</td>
                  <td style={td}>{room.ratePlans.active} active / {room.ratePlans.total}</td>
                  <td style={td}><InventoryChip value={room.inventory} /></td>
                  <td style={td}><ReadinessChip value={room.readiness} blockers={room.blockers} /></td>
                  <td style={td}>{room.blockers.length ? room.blockers.map((b) => <div key={b} title={reasonText(b)}><code>{b}</code></div>) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </div>
  )
}
