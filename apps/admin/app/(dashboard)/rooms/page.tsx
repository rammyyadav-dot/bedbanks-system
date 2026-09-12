'use client'

import { useMemo, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { DetailDrawer, DrawerField } from '@/components/dialogs/DetailDrawer'
import { StatusBadge } from '@/components/status/StatusBadge'
import { rooms as allRooms } from '@/lib/mock'
import type { Room } from '@/lib/types/admin'

export default function RoomsPage() {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Room | null>(null)
  const filtered = useMemo(() => allRooms.filter((r) => r.hotelName.toLowerCase().includes(search.toLowerCase()) || r.type.toLowerCase().includes(search.toLowerCase())), [search])

  const columns: DataTableColumn<Room>[] = [
    { key: 'type', header: 'Room Type', render: (r) => r.type },
    { key: 'hotelName', header: 'Hotel', render: (r) => r.hotelName },
    { key: 'occupancy', header: 'Occupancy', render: (r) => r.occupancy },
    { key: 'bedType', header: 'Bed Type', render: (r) => r.bedType },
    { key: 'mealPlan', header: 'Meal Plan', render: (r) => r.mealPlan },
    { key: 'supplier', header: 'Supplier', render: (r) => r.supplier },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="HOTEL SUPPLY · ROOMS" title="Rooms" description="Room-type inventory across the hotel master." />
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search rooms or hotels…" /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(r) => r.id} onRowClick={setSelected} emptyTitle="No rooms found" />
      <DetailDrawer open={!!selected} onClose={() => setSelected(null)} title={selected?.type ?? ''} subtitle={selected?.hotelName}>
        {selected && (<>
          <DrawerField label="Occupancy" value={selected.occupancy} />
          <DrawerField label="Bed type" value={selected.bedType} />
          <DrawerField label="Meal plan" value={selected.mealPlan} />
          <DrawerField label="Supplier" value={selected.supplier} />
          <DrawerField label="Status" value={<StatusBadge status={selected.status} />} />
        </>)}
      </DetailDrawer>
    </div>
  )
}
