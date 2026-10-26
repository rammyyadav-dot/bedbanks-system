'use client'

import Link from 'next/link'
import { OpsListPage } from '@/components/ops/OpsListPage'
import { StatusBadge } from '@/components/status/StatusBadge'
import { getRoomTypePortfolio, type RoomTypePortfolioRow } from '@/lib/data'

/** Search, sort and pagination run on the API; the hotel name arrives with each row, so no second full list is loaded. */
export default function RoomsPage() {
  return (
    <OpsListPage<RoomTypePortfolioRow>
      eyebrow="HOTEL SUPPLY · ROOMS" title="Rooms" description="Authoritative room types scoped to the active tenant."
      filters={[{ key: 'search', label: 'Search', type: 'text', placeholder: 'Room, code or hotel…' }]}
      load={getRoomTypePortfolio} getRowId={(room) => room.id}
      emptyTitle="No rooms found" emptyDescription="No room type matches these filters. Clear them, or add rooms from a hotel's Rooms tab."
      columns={[
        { key: 'name', header: 'Room type', sortKey: 'name', render: (room) => <Link href={`/hotels/${room.hotelId}/rooms/${room.id}`} style={{ color: 'var(--c-0d2631)', fontWeight: 600, textDecoration: 'none' }}>{room.name}</Link> },
        { key: 'hotel', header: 'Hotel', render: (room) => room.hotel.name },
        { key: 'code', header: 'Code', sortKey: 'code', render: (room) => room.code },
        { key: 'occupancy', header: 'Occupancy', sortKey: 'maxOccupancy', render: (room) => `${room.maxAdults}A + ${room.maxChildren}C · max ${room.maxOccupancy}` },
        { key: 'status', header: 'Status', sortKey: 'isActive', render: (room) => <StatusBadge status={room.isActive ? 'active' : 'inactive'} /> },
      ]}
    />
  )
}
