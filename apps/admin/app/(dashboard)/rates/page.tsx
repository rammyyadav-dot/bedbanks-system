'use client'

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { getRatePlans, type AdminRatePlan } from '@/lib/data'

export default function RatesPage() {
  const [plans, setPlans] = useState<AdminRatePlan[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { getRatePlans().then(setPlans).catch(() => setError('Rate Plans are unavailable. No mock data is shown.')) }, [])
  const columns: DataTableColumn<AdminRatePlan>[] = [
    { key: 'hotel', header: 'Hotel', render: (r) => r.roomType.hotel.name },
    { key: 'room', header: 'Room', render: (r) => r.roomType.name },
    { key: 'board', header: 'Board', render: (r) => r.boardBasis.code.trim() },
    { key: 'contract', header: 'Contract', render: (r) => r.contract.code },
    { key: 'supplier', header: 'Supplier', render: (r) => r.contract.supplier.displayName },
    { key: 'occupancy', header: 'Occupancy', render: (r) => String(r.occupancy), align: 'right' },
    { key: 'currency', header: 'Currency', render: (r) => r.currency },
    { key: 'stay', header: 'Stay', render: (r) => r.maxStay == null ? `${r.minStay}+ nights` : `${r.minStay}–${r.maxStay} nights` },
    { key: 'release', header: 'Release', render: (r) => `${r.releaseDays}d`, align: 'right' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status.toLowerCase() as 'active' | 'inactive' | 'pending' | 'suspended'} /> },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="COMMERCIAL · RATE PLANS" title="Rate Plans" description="Authoritative contract, room, board, occupancy and stay rules. Daily prices are managed separately." />
      {error ? <div role="alert" className="admin-empty-state">{error}</div> : null}
      <DataTable columns={columns} data={plans} getRowId={(r) => r.id} emptyTitle={error ? 'Rate Plans unavailable' : 'No Rate Plans found'} />
    </div>
  )
}
