'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/common/PageHeader'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { HealthBadge } from '@/components/status/HealthBadge'
import { StatusBadge } from '@/components/status/StatusBadge'
import { suppliers as allSuppliers } from '@/lib/mock'
import type { Supplier } from '@/lib/types/admin'

export default function SuppliersPage() {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => allSuppliers.filter((s) => s.name.toLowerCase().includes(search.toLowerCase())), [search])

  const columns: DataTableColumn<Supplier>[] = [
    { key: 'name', header: 'Supplier', render: (s) => <Link href={`/suppliers/${s.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{s.name}</Link> },
    { key: 'type', header: 'Type', render: (s) => s.type },
    { key: 'connection', header: 'Connection', render: (s) => <HealthBadge state={s.connection} /> },
    { key: 'hotels', header: 'Hotels', render: (s) => s.hotels.toLocaleString(), align: 'right' },
    { key: 'lastSync', header: 'Last Sync', render: (s) => new Date(s.lastSync).toLocaleString() },
    { key: 'successRate', header: 'Success Rate', render: (s) => `${s.successRate}%`, align: 'right' },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} /> },
  ]

  return (
    <div className="admin-page">
      <PageHeader eyebrow="SUPPLIERS" title="Suppliers" description="Connected supply sources and integration health." />
      <TableToolbar><SearchInput value={search} onChange={setSearch} placeholder="Search suppliers…" /></TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(s) => s.id} emptyTitle="No suppliers found" />
    </div>
  )
}
