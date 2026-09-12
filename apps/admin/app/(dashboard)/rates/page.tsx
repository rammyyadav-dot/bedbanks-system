'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { rates } from '@/lib/mock'
import type { RateRow } from '@/lib/types/admin'

export default function RatesPage() {
  const columns: DataTableColumn<RateRow>[] = [
    { key: 'hotel', header: 'Hotel', render: (r) => r.hotel },
    { key: 'room', header: 'Room', render: (r) => r.room },
    { key: 'mealPlan', header: 'Meal Plan', render: (r) => r.mealPlan },
    { key: 'date', header: 'Date', render: (r) => r.date },
    { key: 'supplierCost', header: 'Supplier Cost', render: (r) => `${r.currency} ${r.supplierCost.toFixed(2)}`, align: 'right' },
    { key: 'markup', header: 'Markup', render: (r) => `${r.markup}%`, align: 'right' },
    { key: 'sellRate', header: 'Sell Rate', render: (r) => `${r.currency} ${r.sellRate.toFixed(2)}`, align: 'right' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="DISTRIBUTION · RATES" title="Rates" description="Supplier cost, markup, and sell rate by hotel, room, and date." actions={<input type="date" defaultValue="2026-09-15" className="admin-filter-select" />} />
      <DataTable columns={columns} data={rates} getRowId={(r) => r.id} emptyTitle="No rates found" />
    </div>
  )
}
