'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { inventory } from '@/lib/mock'
import type { InventoryRow } from '@/lib/types/admin'

export default function InventoryPage() {
  const columns: DataTableColumn<InventoryRow>[] = [
    { key: 'hotel', header: 'Hotel', render: (r) => r.hotel },
    { key: 'room', header: 'Room', render: (r) => r.room },
    { key: 'date', header: 'Date', render: (r) => r.date },
    { key: 'allotment', header: 'Allotment', render: (r) => r.allotment, align: 'right' },
    { key: 'available', header: 'Available', render: (r) => r.available, align: 'right' },
    { key: 'stopSell', header: 'Stop Sell', render: (r) => (r.stopSell ? <span className="status-pill danger"><i className="status-dot" />Stop sell</span> : '—') },
    { key: 'release', header: 'Release', render: (r) => `${r.release}d`, align: 'right' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DISTRIBUTION · INVENTORY" title="Inventory" description="Operational allotment and stop-sell status by hotel, room, and date." actions={<input type="date" defaultValue="2026-09-15" className="admin-filter-select" />} />
      <DataTable columns={columns} data={inventory} getRowId={(r) => r.id} emptyTitle="No inventory rows found" />
    </div>
  )
}
