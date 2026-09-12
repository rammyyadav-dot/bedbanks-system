'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { cancellations } from '@/lib/mock'
import type { CancellationRow } from '@/lib/types/admin'

export default function CancellationsPage() {
  const columns: DataTableColumn<CancellationRow>[] = [
    { key: 'booking', header: 'Booking', render: (r) => r.booking },
    { key: 'hotel', header: 'Hotel', render: (r) => r.hotel },
    { key: 'guest', header: 'Guest', render: (r) => r.guest },
    { key: 'deadline', header: 'Cancellation Deadline', render: (r) => r.deadline },
    { key: 'penalty', header: 'Penalty', render: (r) => `$${r.penalty.toFixed(2)}`, align: 'right' },
    { key: 'refund', header: 'Refund', render: (r) => `$${r.refund.toFixed(2)}`, align: 'right' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="BOOKINGS · CANCELLATIONS" title="Cancellations" description="Pending and processed cancellations with penalty and refund detail." />
      <DataTable columns={columns} data={cancellations} getRowId={(r) => r.id} emptyTitle="No cancellations found" />
    </div>
  )
}
