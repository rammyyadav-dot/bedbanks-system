'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { PlatformTenantView } from '@bedbanks/contracts'
import { TableToolbar } from '@/components/tables/TableToolbar'
import { SearchInput } from '@/components/forms/SearchInput'
import { SelectField } from '@/components/forms/SelectField'
import { DataTable, type DataTableColumn } from '@/components/tables/DataTable'
import { StatusBadge } from '@/components/status/StatusBadge'
import { tenantStatus } from './tenant-status'

export function TenantsTable({ tenants }: { tenants: PlatformTenantView[] }) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tenants.filter((t) =>
      (status === 'all' || t.status === status) &&
      (t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q)),
    )
  }, [tenants, search, status])

  const columns: DataTableColumn<PlatformTenantView>[] = [
    { key: 'name', header: 'Tenant', render: (t) => <Link href={`/tenants/${t.id}`} style={{ color: '#0d2631', fontWeight: 600, textDecoration: 'none' }}>{t.name}</Link> },
    { key: 'slug', header: 'Slug', render: (t) => t.slug },
    { key: 'createdAt', header: 'Created', render: (t) => new Date(t.createdAt).toLocaleDateString() },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={tenantStatus(t.status)} /> },
  ]

  return (
    <>
      <TableToolbar>
        <SearchInput value={search} onChange={setSearch} placeholder="Search tenants by name or slug…" />
        <SelectField label="Status" value={status} onChange={setStatus} options={[
          { value: 'all', label: 'All statuses' }, { value: 'ACTIVE', label: 'Active' }, { value: 'SUSPENDED', label: 'Suspended' },
        ]} />
      </TableToolbar>
      <DataTable columns={columns} data={filtered} getRowId={(t) => t.id} emptyTitle="No tenants found" />
    </>
  )
}
