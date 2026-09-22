'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { SelectField } from '@/components/forms/SelectField'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { AdminLoadingState, AdminServiceUnavailable, AccessDenied, AuthRequired } from '@/components/auth/AuthorizationStates'
import { apiRequest } from '@/lib/api/client'
import { ApiResponseError } from '@/lib/api/errors'

type Hotel = { id: string; name: string; propertyType: string; starRating: number | null; city: string; countryCode: string; contentStatus: string; updatedAt: string }

function status(value: string) { return value.toLowerCase() === 'published' ? 'active' : value.toLowerCase() === 'suspended' ? 'suspended' : value.toLowerCase() === 'archived' ? 'inactive' : 'pending' }

export default function HotelsPage() {
  const [hotels, setHotels] = useState<Hotel[]>([])
  const [search, setSearch] = useState('')
  const [destination, setDestination] = useState('all')
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'auth' | 'forbidden'>('loading')

  useEffect(() => {
    let active = true
    apiRequest<Hotel[]>('/supply/hotels').then((data) => { if (active) { setHotels(data); setState('ready') } }).catch((error) => { if (!active) return; if (error instanceof ApiResponseError && error.status === 401) setState('auth'); else if (error instanceof ApiResponseError && error.status === 403) setState('forbidden'); else setState('error') })
    return () => { active = false }
  }, [])

  const destinations = Array.from(new Set(hotels.map((hotel) => hotel.city))).sort()
  const filtered = useMemo(() => hotels.filter((hotel) => (destination === 'all' || hotel.city === destination) && `${hotel.name} ${hotel.city}`.toLowerCase().includes(search.toLowerCase())), [hotels, search, destination])
  const columns: DataTableColumn<Hotel>[] = [
    { key: 'name', header: 'Hotel', render: (hotel) => <Link href={`/hotels/${hotel.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{hotel.name}</Link> },
    { key: 'propertyType', header: 'Property type', render: (hotel) => hotel.propertyType },
    { key: 'destination', header: 'Destination', render: (hotel) => `${hotel.city}, ${hotel.countryCode}` },
    { key: 'stars', header: 'Stars', render: (hotel) => hotel.starRating ? '★'.repeat(hotel.starRating) : '—', align: 'center' },
    { key: 'updatedAt', header: 'Updated', render: (hotel) => new Date(hotel.updatedAt).toLocaleDateString() },
    { key: 'status', header: 'Status', render: (hotel) => <StatusBadge status={status(hotel.contentStatus)} /> },
  ]

  return <div className="admin-page">
    <PageHeader eyebrow="HOTEL SUPPLY · HOTELS" title="Hotels" description="Manage authoritative FBEDS hotel master data." actions={<Link href="/hotels/new" className="button primary">+ Add hotel</Link>} />
    {state === 'loading' && <AdminLoadingState />}
    {state === 'auth' && <AuthRequired />}
    {state === 'forbidden' && <AccessDenied permission="supply.hotels.read" />}
    {state === 'error' && <AdminServiceUnavailable onRetry={() => window.location.reload()} />}
    {state === 'ready' && <>
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search hotels…" /><SelectField label="Destination" value={destination} onChange={setDestination} options={[{ value: 'all', label: 'All destinations' }, ...destinations.map((city) => ({ value: city, label: city }))]} /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(hotel) => hotel.id} emptyTitle={hotels.length === 0 ? 'No hotels in this tenant' : 'No hotels found'} />
    </>}
  </div>
}
