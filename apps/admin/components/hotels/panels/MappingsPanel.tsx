'use client'

import { OpsState } from '@/components/ops/OpsState'
import { useOpsQuery } from '@/components/ops/useOpsQuery'
import { getHotelMappings } from '@/lib/data/hotel-commercial'
import { when } from '@/components/ops/ops-ui'
import { Chip, ScrollRegion, td, th, tableStyle } from '../ui'
import { mappingTone } from '@/lib/hotel-ui'
import type { MappingState } from '@bedbanks/contracts'

export function MappingsPanel({ hotelId }: { hotelId: string }) {
  const { state, reload } = useOpsQuery(() => getHotelMappings(hotelId), [hotelId])
  return (
    <OpsState state={state} onRetry={reload}>
      {(data) => (
        <div style={{ display: 'grid', gap: 16 }}>
          <div className="workspace-panel" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Hotel mapping</h2>
            {data.hotelMappings.length === 0 ? <p data-testid="hotel-mapping-empty">No supplier hotel mapping exists. Until a mapping is approved, no supplier can sell this hotel.</p> : (
              <ScrollRegion label="Hotel mappings"><table style={tableStyle} aria-label="Hotel mappings"><thead><tr>{['Supplier', 'Supplier hotel id', 'Status', 'Confidence', 'Updated'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.hotelMappings.map((m) => <tr key={m.id}><td style={td}>{m.supplierName}</td><td style={td}><code>{m.supplierHotelId}</code></td><td style={td}><Chip tone={mappingTone(m.status as MappingState)}>{m.status}</Chip></td><td style={td}>{m.confidence ?? '—'}</td><td style={td}>{when(m.updatedAt)}</td></tr>)}</tbody></table></ScrollRegion>
            )}
          </div>
          <div className="workspace-panel" style={{ padding: 18 }}>
            <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Room mapping</h2>
            {data.roomMappings.length === 0 ? <p data-testid="room-mapping-empty">No supplier room mapping exists.</p> : (
              <ScrollRegion label="Room mappings"><table style={tableStyle} aria-label="Room mappings"><thead><tr>{['Canonical room', 'Supplier room id', 'Status', 'Confidence', 'Updated'].map((h) => <th key={h} scope="col" style={th}>{h}</th>)}</tr></thead>
                <tbody>{data.roomMappings.map((m) => <tr key={m.id}><td style={td}>{m.roomName}</td><td style={td}><code>{m.supplierRoomId}</code></td><td style={td}><Chip tone={mappingTone(m.status as MappingState)}>{m.status}</Chip></td><td style={td}>{m.confidence ?? '—'}</td><td style={td}>{when(m.updatedAt)}</td></tr>)}</tbody></table></ScrollRegion>
            )}
            {data.unmappedRooms.length > 0 && (
              <div role="status" data-testid="unmapped-rooms" style={{ marginTop: 12 }}>
                <strong>Active rooms without an approved mapping</strong>
                <ul>{data.unmappedRooms.map((r) => <li key={`${r.hotelMappingId}-${r.roomTypeId}`}>{r.roomName} <span style={{ color: '#3f565c' }}>(under {r.supplierName})</span></li>)}</ul>
                <p style={{ color: '#3f565c', fontSize: 12 }}>Mappings are approved in Mapping governance; rooms are never matched by name.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </OpsState>
  )
}
