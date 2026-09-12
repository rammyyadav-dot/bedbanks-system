'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { wallets } from '@/lib/mock'
import type { Wallet } from '@/lib/types/admin'

export default function WalletsPage() {
  const columns: DataTableColumn<Wallet>[] = [
    { key: 'tenant', header: 'Tenant', render: (w) => w.tenant },
    { key: 'available', header: 'Available Credit', render: (w) => `${w.currency} ${w.availableCredit.toLocaleString()}`, align: 'right' },
    { key: 'used', header: 'Used Credit', render: (w) => `${w.currency} ${w.usedCredit.toLocaleString()}`, align: 'right' },
    { key: 'limit', header: 'Limit', render: (w) => `${w.currency} ${w.limit.toLocaleString()}`, align: 'right' },
    { key: 'status', header: 'Status', render: (w) => <StatusBadge status={w.status} /> },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · WALLETS" title="Wallets" description="Per-tenant credit balance and limits." />
      <DataTable columns={columns} data={wallets} getRowId={(w) => w.tenantId} emptyTitle="No wallets found" />
    </div>
  )
}
