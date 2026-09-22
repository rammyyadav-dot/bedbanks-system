'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { AdminLoadingState, AdminServiceUnavailable, AccessDenied, AuthRequired } from '@/components/auth/AuthorizationStates'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'

type Room = { id: string; hotelId: string; name: string; code: string; maxAdults: number; maxChildren: number; maxOccupancy: number; isActive: boolean }
type Hotel = { id: string; name: string; city: string; countryCode: string }

export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [hotels, setHotels] = useState<Hotel[]>([])
  const [search, setSearch] = useState('')
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'auth' | 'forbidden'>('loading')

  useEffect(() => {
    let active = true
    Promise.all([apiRequest<Room[]>('/supply/room-types'), apiRequest<Hotel[]>('/supply/hotels')])
      .then(([roomData, hotelData]) => { if (active) { setRooms(roomData); setHotels(hotelData); setState('ready') } })
      .catch((error) => { if (!active) return; if (error instanceof ApiResponseError && error.status === 401) setState('auth'); else if (error instanceof ApiResponseError && error.status === 403) setState('forbidden'); else setState('error') })
    return () => { active = false }
  }, [])

  const hotelNames = useMemo(() => new Map(hotels.map(hotel => [hotel.id, hotel.name])), [hotels])
  const filtered = useMemo(() => rooms.filter(room => `${room.name} ${room.code} ${hotelNames.get(room.hotelId) ?? ''}`.toLowerCase().includes(search.toLowerCase())), [rooms, search, hotelNames])
  const columns: DataTableColumn<Room>[] = [
    { key: 'name', header: 'Room type', render: room => <Link href={`/hotels/${room.hotelId}/rooms/${room.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{room.name}</Link> },
    { key: 'hotel', header: 'Hotel', render: room => hotelNames.get(room.hotelId) ?? '—' },
    { key: 'code', header: 'Code', render: room => room.code },
    { key: 'occupancy', header: 'Occupancy', render: room => `${room.maxAdults}A + ${room.maxChildren}C · max ${room.maxOccupancy}` },
    { key: 'status', header: 'Status', render: room => <StatusBadge status={room.isActive ? 'active' : 'inactive'} /> },
  ]

  return <div className="admin-page">
    <PageHeader eyebrow="HOTEL SUPPLY · ROOMS" title="Rooms" description="Authoritative room types scoped to the active tenant." />
    {state === 'loading' && <AdminLoadingState />}
    {state === 'auth' && <AuthRequired />}
    {state === 'forbidden' && <AccessDenied permission="supply.rooms.read" />}
    {state === 'error' && <AdminServiceUnavailable onRetry={() => window.location.reload()} />}
    {state === 'ready' && <>
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search rooms or hotels…" /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={room => room.id} emptyTitle={rooms.length === 0 ? 'No rooms in this tenant' : 'No rooms found'} />
    </>}
  </div>
}
