'use client'

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { getInventory, type AdminAvailabilityRow } from '@/lib/data'

const today = new Date().toISOString().slice(0, 10)

export default function InventoryPage() {
  const [dateValue, setDateValue] = useState(today)
  const [rows, setRows] = useState<AdminAvailabilityRow[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setError(null); getInventory(dateValue).then(setRows).catch(() => { setRows([]); setError('Inventory is unavailable. No mock data is shown.') }) }, [dateValue])
  const columns: DataTableColumn<AdminAvailabilityRow>[] = [
    { key: 'hotel', header: 'Hotel', render: (r) => r.ratePlan.roomType.hotel.name },
    { key: 'room', header: 'Room', render: (r) => r.ratePlan.roomType.name },
    { key: 'board', header: 'Board', render: (r) => r.ratePlan.boardBasis.code.trim() },
    { key: 'date', header: 'Date', render: (r) => r.stayDate.slice(0, 10) },
    { key: 'allotment', header: 'Allotment', render: (r) => r.allotment, align: 'right' },
    { key: 'available', header: 'Available', render: (r) => Math.max(0, r.allotment - r.sold - r.held), align: 'right' },
    { key: 'stopSell', header: 'Stop Sell', render: (r) => r.stopSell ? <span className="status-pill danger"><i className="status-dot" />Stop sell</span> : 'Open' },
    { key: 'minStay', header: 'Min stay', render: (r) => `${r.minStay}n`, align: 'right' },
    { key: 'release', header: 'Release', render: (r) => `${r.ratePlan.releaseDays}d`, align: 'right' },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DISTRIBUTION · INVENTORY" title="Inventory" description="Authoritative allotment, held/sold inventory and stop-sell state by rate plan and stay date." actions={<input aria-label="Inventory date" type="date" value={dateValue} onChange={(event) => setDateValue(event.target.value)} className="admin-filter-select" />} />
      {error ? <div role="alert" className="admin-empty-state">{error}</div> : null}
      <DataTable columns={columns} data={rows} getRowId={(r) => r.id} emptyTitle={error ? 'Inventory unavailable' : 'No inventory rows found'} />
    </div>
  )
}
