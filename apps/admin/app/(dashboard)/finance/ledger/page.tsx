'use client'

import { PageHeader } from '@/components/common/PageHeader'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { ledger } from '@/lib/mock'
import type { LedgerEntry } from '@/lib/types/admin'

export default function LedgerPage() {
  const columns: DataTableColumn<LedgerEntry>[] = [
    { key: 'date', header: 'Date', render: (l) => l.date },
    { key: 'tenant', header: 'Tenant', render: (l) => l.tenant },
    { key: 'reference', header: 'Reference', render: (l) => l.reference },
    { key: 'type', header: 'Type', render: (l) => l.type },
    { key: 'debit', header: 'Debit', render: (l) => (l.debit ? `$${l.debit.toFixed(2)}` : '—'), align: 'right' },
    { key: 'credit', header: 'Credit', render: (l) => (l.credit ? `$${l.credit.toFixed(2)}` : '—'), align: 'right' },
    { key: 'balance', header: 'Balance', render: (l) => `$${l.balance.toLocaleString()}`, align: 'right' },
  ]
  return (
    <div className="admin-page">
      <PageHeader eyebrow="FINANCE · LEDGER" title="Ledger" description="Immutable append-only record of wallet debits and credits." />
      <DataTable columns={columns} data={ledger} getRowId={(l) => l.id} emptyTitle="No ledger entries found" />
    </div>
  )
}
