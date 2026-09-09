'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { SelectField } from '@/components/forms/SelectField'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { hotels as allHotels } from '@/lib/mock'
import type { Hotel } from '@/lib/types/admin'

export default function HotelsPage() {
  const [search, setSearch] = useState('')
  const [destination, setDestination] = useState('all')
  const destinations = Array.from(new Set(allHotels.map((h) => h.destination)))

  const filtered = useMemo(() => allHotels.filter((h) =>
    (destination === 'all' || h.destination === destination) && h.name.toLowerCase().includes(search.toLowerCase()),
  ), [search, destination])

  const columns: DataTableColumn<Hotel>[] = [
    { key: 'name', header: 'Hotel', render: (h) => <Link href={`/hotels/${h.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{h.name}</Link> },
    { key: 'code', header: 'Hotel Code', render: (h) => h.code },
    { key: 'destination', header: 'Destination', render: (h) => `${h.destination}, ${h.country}` },
    { key: 'stars', header: 'Stars', render: (h) => '★'.repeat(h.stars), align: 'center' },
    { key: 'supplier', header: 'Supplier', render: (h) => h.supplier },
    { key: 'updatedAt', header: 'Updated', render: (h) => h.updatedAt },
    { key: 'status', header: 'Status', render: (h) => <StatusBadge status={h.status} /> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="HOTEL SUPPLY · HOTELS" title="Hotels" description="Manage FBEDS hotel master data, mappings, and distribution status." actions={<button type="button" className="admin-btn admin-btn-primary">+ Add hotel</button>} />
      <TableToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search hotels…" />
        <SelectField label="Destination" value={destination} onChange={setDestination} options={[{ value: 'all', label: 'All destinations' }, ...destinations.map((d) => ({ value: d, label: d }))]} />
      </TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(h) => h.id} emptyTitle="No hotels found" />
    </div>
  )
}
