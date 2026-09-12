'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { payments } from '@/lib/mock'
import type { Payment } from '@/lib/types/admin'

export default function PaymentsPage() {
  const columns: DataTableColumn<Payment>[] = [
    { key: 'reference', header: 'Reference', render: (p) => p.reference },
    { key: 'tenant', header: 'Tenant', render: (p) => p.tenant },
    { key: 'amount', header: 'Amount', render: (p) => `${p.currency} ${p.amount.toFixed(2)}`, align: 'right' },
    { key: 'method', header: 'Method', render: (p) => p.method },
    { key: 'status', header: 'Status', render: (p) => <span className={`status-pill ${p.status === 'success' ? 'success' : p.status === 'pending' ? 'warning' : 'danger'}`}><i className="status-dot" />{p.status}</span> },
    { key: 'date', header: 'Date', render: (p) => p.date },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · PAYMENTS" title="Payments" description="Incoming payments and wallet top-ups." />
      <DataTable columns={columns} data={payments} getRowId={(p) => p.id} emptyTitle="No payments found" />
    </div>
  )
}
